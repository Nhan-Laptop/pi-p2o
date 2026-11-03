'use client';
/**
 * planning_update.md P2: the node detail panel. It shows what the record says (text, body excerpt, relations, anchors) and
 * never summarises further: a value the projection does not hold is printed as "not recorded", not guessed.
 */
import type { DashboardNode, DashboardRunFile } from '../lib/model';
import type { GraphLayout, LayoutNode } from '../lib/layout';
import { kindGlyph, kindLabel, relationLabel } from '../lib/vocabulary';
import { plural, shortId } from '../lib/format';

export interface GraphDetailProps {
  runFile: DashboardRunFile;
  layout: GraphLayout;
  selected: LayoutNode | null;
  focusId: string | null;
  onSelect: (id: string | null) => void;
  onFocus: (id: string | null) => void;
}

function BodyExcerpt({ node }: { node: DashboardNode }) {
  if (node.bodyOmitted) {
    return <p className="detail-note">body omitted: it is above the display cap, so the projection kept the row and dropped the body. The record id below is the pointer into the ledger.</p>;
  }
  if (!node.body) return <p className="detail-note">no body recorded on this node.</p>;
  return <pre className="detail-body">{JSON.stringify(node.body, null, 2)}</pre>;
}

export function GraphDetail({ runFile, layout, selected, focusId, onSelect, onFocus }: GraphDetailProps) {
  const drawn = new Map(layout.nodes.map(node => [node.id, node]));
  const incoming = selected ? layout.edges.filter(edge => edge.dstId === selected.id) : [];
  const outgoing = selected ? layout.edges.filter(edge => edge.srcId === selected.id) : [];
  const anchors = selected ? runFile.graph.anchors.filter(anchor => anchor.nodeId === selected.id) : [];

  return (
    <aside className="detail" aria-label="node detail">
      {selected === null ? (
        <div className="detail-empty">
          <h2>select a node</h2>
          <p>Click a card to read its committed state, body and relations. The graph is a derived projection of this run&apos;s records; every node carries the pointer to the row it came from.</p>
          {focusId ? <button type="button" className="button button-quiet" onClick={() => onFocus(null)}>clear focus</button> : null}
        </div>
      ) : (
        <>
          <header className="detail-head">
            <span className="detail-glyph">{kindGlyph(selected.kind)}</span>
            <h2>{kindLabel(selected.kind)}<span className="detail-state">{selected.state}</span></h2>
            <button type="button" className="button button-quiet" onClick={() => onSelect(null)} aria-label="close node detail">close</button>
          </header>
          <p className="detail-text">{selected.node.text}</p>
          <dl className="detail-facts">
            <div><dt>id</dt><dd className="mono">{selected.node.id}</dd></div>
            <div><dt>entity</dt><dd className="mono">{selected.node.entityId}</dd></div>
            {selected.node.recordId ? <div><dt>record</dt><dd className="mono">{selected.node.recordId}</dd></div> : null}
            <div><dt>provenance</dt><dd>{selected.node.inherited ? <span className="mono">inherited from run {selected.node.inherited}</span> : 'committed by this run'}</dd></div>
            {selected.node.kind === 'goal' || selected.node.kind === 'intent'
              ? <div><dt>priority</dt><dd>not recorded; the plan stores no priority for this row</dd></div>
              : null}
          </dl>
          {selected.foldedDigest ? (
            <p className="detail-note">Folded digest super-node: {plural(selected.foldedDigest.rounds, 'digest row')} covering {plural(selected.foldedDigest.covered, 'row')}. Turn off folding in the rail to inspect each digest and its membership edges.</p>
          ) : null}
          <section className="detail-section">
            <h3>body</h3>
            <BodyExcerpt node={selected.node} />
          </section>
          <section className="detail-section">
            <h3>incoming <span className="detail-count">{incoming.length}</span></h3>
            <RelationList edges={incoming} drawn={drawn} side="srcId" onSelect={onSelect} />
          </section>
          <section className="detail-section">
            <h3>outgoing <span className="detail-count">{outgoing.length}</span></h3>
            <RelationList edges={outgoing} drawn={drawn} side="dstId" onSelect={onSelect} />
          </section>
          {anchors.length ? (
            <section className="detail-section">
              <h3>asset anchors <span className="detail-count">{anchors.length}</span></h3>
              <ul className="detail-anchors">
                {anchors.map(anchor => <li key={`${anchor.nodeId}-${anchor.assetEntity}`} className="mono">{shortId(anchor.assetEntity, 48)}{anchor.inherited ? ` (from ${anchor.inherited})` : ''}</li>)}
              </ul>
            </section>
          ) : null}
          <div className="detail-actions">
            <button type="button" className="button" onClick={() => onFocus(focusId === selected.id ? null : selected.id)}>{focusId === selected.id ? 'clear focus' : 'focus on this node'}</button>
          </div>
        </>
      )}
    </aside>
  );
}

function RelationList({ edges, drawn, side, onSelect }: { edges: GraphLayout['edges']; drawn: Map<string, LayoutNode>; side: 'srcId' | 'dstId'; onSelect: (id: string | null) => void }) {
  if (!edges.length) return <p className="detail-note">none drawn. Edges whose ends are outside the current window are not listed here; clear filters or the focus window to see them.</p>;
  return (
    <ul className="detail-relations">
      {edges.map(edge => {
        const neighbourId = edge[side];
        const neighbour = drawn.get(neighbourId);
        return (
          <li key={`${edge.srcId}-${edge.rel}-${edge.dstId}`}>
            <span className="relation-label">{relationLabel(edge.rel)}</span>
            {neighbour ? (
              <button type="button" className="link-button" onClick={() => onSelect(neighbourId)}>
                <span className="kind-mark">{kindGlyph(neighbour.kind)}</span>{shortId(neighbour.node.text, 72)}
              </button>
            ) : (
              <span className="relation-hidden">{shortId(neighbourId, 36)} (not drawn)</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
