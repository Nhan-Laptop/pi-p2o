'use client';
/**
 * planning_update.md P2: the graph canvas. SVG, no DOM measurement per node, no library: the pure layout in
 * `lib/layout.ts` supplies coordinates and this file only pans, zooms, renders and selects. Nothing here can mutate the data
 * it receives (it holds a parsed snapshot), and the only fetch path stays in `lib/use-json.ts`.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { edgePath, GRAPH_COLUMN_GAP, GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, type GraphLayout, type LayoutEdge, type LayoutNode } from '../lib/layout';
import { kindGlyph, kindLabel, RELATION_STYLES, relationTone } from '../lib/vocabulary';
import { shortId, wrapText } from '../lib/format';

const COLUMN_STRIDE = GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP;
const MIN_SCALE = 0.12;
const MAX_SCALE = 3;
const ZOOM_STEP = 1.2;
const MINIMAP_WIDTH = 168;
const MINIMAP_HEIGHT = 104;
const TONES = [...new Set([...Object.values(RELATION_STYLES).map(style => style.tone), 'other'])];

interface Viewport { x: number; y: number; k: number }

export interface GraphCanvasProps {
  layout: GraphLayout;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

/** One node card. Text is pre-wrapped for SVG, and the clipped lines keep their title so the full string stays reachable. */
function NodeCard({ laid, selected, onActivate }: { laid: LayoutNode; selected: boolean; onActivate: () => void }) {
  const { node } = laid;
  const lines = wrapText(node.text, 28, 2);
  const priorityNote = !node.inherited && !laid.foldedDigest && (node.kind === 'goal' || node.kind === 'intent');
  const activate = (event: ReactMouseEvent | ReactKeyboardEvent) => { event.stopPropagation(); onActivate(); };
  return (
    <g
      className={`node kind-${node.kind}${node.inherited ? ' is-inherited' : ''}${selected ? ' is-selected' : ''}`}
      transform={`translate(${laid.x} ${laid.y})`}
      role="button"
      tabIndex={0}
      aria-label={`${kindLabel(node.kind)} (${node.state}): ${node.text}`}
      onClick={activate}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(event); } }}
    >
      <title>{node.text}</title>
      <rect className="node-box" width={GRAPH_NODE_WIDTH} height={GRAPH_NODE_HEIGHT} rx={2} />
      <text className="node-kind" x={10} y={14}>{kindGlyph(node.kind)} {kindLabel(node.kind)}</text>
      <text className="node-state" x={GRAPH_NODE_WIDTH - 10} y={14} textAnchor="end">{node.state}</text>
      {lines.map((line, index) => <text key={index} className="node-text" x={10} y={29 + index * 13}>{line}</text>)}
      {priorityNote
        ? <text className="node-prio" x={10} y={GRAPH_NODE_HEIGHT - 5}>priority: not recorded</text>
        : <text className="node-id" x={10} y={GRAPH_NODE_HEIGHT - 5}>{shortId(node.id, 16)}</text>}
      {node.inherited ? <text className="node-inherit" x={GRAPH_NODE_WIDTH - 10} y={GRAPH_NODE_HEIGHT - 5} textAnchor="end">from {shortId(node.inherited, 10)}</text> : null}
      {laid.foldedDigest ? <text className="node-fold" x={GRAPH_NODE_WIDTH - 10} y={GRAPH_NODE_HEIGHT - 5} textAnchor="end">{laid.foldedDigest.rounds} folded</text> : null}
    </g>
  );
}

function Minimap({ layout, size, viewport, onCenter }: { layout: GraphLayout; size: { width: number; height: number }; viewport: Viewport; onCenter: (x: number, y: number) => void }) {
  if (!layout.width || !layout.height) return null;
  const scale = Math.min(MINIMAP_WIDTH / layout.width, MINIMAP_HEIGHT / layout.height);
  const offsetX = (MINIMAP_WIDTH - layout.width * scale) / 2;
  const offsetY = (MINIMAP_HEIGHT - layout.height * scale) / 2;
  const visible = { x: -viewport.x / viewport.k, y: -viewport.y / viewport.k, width: size.width / viewport.k, height: size.height / viewport.k };
  const handleClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onCenter((event.clientX - rect.left - offsetX) / scale, (event.clientY - rect.top - offsetY) / scale);
  };
  return (
    <svg className="minimap" width={MINIMAP_WIDTH} height={MINIMAP_HEIGHT} viewBox={`0 0 ${MINIMAP_WIDTH} ${MINIMAP_HEIGHT}`} onClick={handleClick} aria-label="minimap" role="img">
      {layout.nodes.map(node => (
        <rect key={node.id} className={`mini-node kind-${node.kind}`} x={offsetX + node.x * scale} y={offsetY + node.y * scale} width={GRAPH_NODE_WIDTH * scale} height={GRAPH_NODE_HEIGHT * scale} />
      ))}
      <rect className="mini-view" x={offsetX + visible.x * scale} y={offsetY + visible.y * scale} width={Math.max(3, visible.width * scale)} height={Math.max(3, visible.height * scale)} />
    </svg>
  );
}

export function GraphCanvas({ layout, selectedId, onSelect }: GraphCanvasProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, k: 1 });
  const moved = useRef(false);
  const suppressClick = useRef(false);
  const drag = useRef<{ clientX: number; clientY: number; originX: number; originY: number; distance: number } | null>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => setSize({ width: frame.clientWidth, height: frame.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  /** `floor` keeps the first paint readable: a wide graph opens at card-legible scale and the operator pans or presses
   *  fit for the whole picture, instead of landing on a wall of six-pixel labels. */
  const fit = useCallback((floor = MIN_SCALE) => {
    if (!size.width || !size.height || !layout.width || !layout.height) { setViewport({ x: 0, y: 0, k: 1 }); return; }
    const pad = 56;
    const k = Math.max(floor, Math.min((size.width - pad * 2) / layout.width, (size.height - pad * 2) / layout.height, 1.15));
    setViewport({ k, x: (size.width - layout.width * k) / 2, y: (size.height - layout.height * k) / 2 });
    moved.current = false;
  }, [layout.height, layout.width, size.height, size.width]);

  useEffect(() => { if (!moved.current) fit(0.8); }, [fit]);

  const zoomAt = useCallback((x: number, y: number, factor: number) => {
    moved.current = true;
    setViewport(previous => {
      const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, previous.k * factor));
      const ratio = k / previous.k;
      return { k, x: x - (x - previous.x) * ratio, y: y - (y - previous.y) * ratio };
    });
  }, []);

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    zoomAt(event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  };

  const pointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    if ((event.target as Element).closest('.node')) return;
    drag.current = { clientX: event.clientX, clientY: event.clientY, originX: viewport.x, originY: viewport.y, distance: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const current = drag.current;
    if (!current) return;
    const dx = event.clientX - current.clientX;
    const dy = event.clientY - current.clientY;
    current.distance = Math.max(current.distance, Math.abs(dx) + Math.abs(dy));
    moved.current = true;
    setViewport(previous => ({ ...previous, x: current.originX + dx, y: current.originY + dy }));
  };
  const pointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const current = drag.current;
    drag.current = null;
    if (current && current.distance > 4) suppressClick.current = true;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const backgroundClick = () => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    onSelect(null);
  };

  const centerOn = (worldX: number, worldY: number) => {
    moved.current = true;
    setViewport(previous => ({ ...previous, x: size.width / 2 - worldX * previous.k, y: size.height / 2 - worldY * previous.k }));
  };

  return (
    <div className="canvas" ref={frameRef} onWheel={onWheel}>
      <svg className="canvas-svg" role="img" aria-label={`exploration graph: ${layout.totals.drawn} of ${layout.totals.afterFilters} nodes shown`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onClick={backgroundClick}>
        <defs>
          {TONES.map(tone => (
            <marker key={tone} id={`arrow-${tone}`} className={`arrow rel-${tone}`} viewBox="0 0 6 6" refX={5} refY={3} markerWidth={6} markerHeight={6} orient="auto">
              <path d="M0 0 L6 3 L0 6 z" />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.k})`}>
          <g className="bands" aria-hidden="true">
            {Array.from({ length: Math.max(1, layout.columns) }, (_, column) => (
              <rect key={column} className={`band band-${column % 2}`} x={column * COLUMN_STRIDE} y={-72} width={GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP} height={Math.max(layout.height, 320) + 144} />
            ))}
          </g>
          <g className="edges" aria-hidden="true">
            {layout.edges.map((edge: LayoutEdge) => {
              const tone = relationTone(edge.rel);
              const path = edgePath(layout, edge);
              return path ? <path key={`${edge.srcId}-${edge.rel}-${edge.dstId}`} className={`edge rel-${tone}${edge.inherited ? ' is-inherited' : ''}`} d={path} markerEnd={`url(#arrow-${tone})`} /> : null;
            })}
          </g>
          <g className="nodes">
            {layout.nodes.map(laid => <NodeCard key={laid.id} laid={laid} selected={laid.id === selectedId} onActivate={() => onSelect(laid.id)} />)}
          </g>
        </g>
      </svg>
      {layout.nodes.length === 0 ? <p className="canvas-empty">no node matches the current filters</p> : null}
      <div className="canvas-controls">
        <button type="button" onClick={() => zoomAt(size.width / 2, size.height / 2, ZOOM_STEP)} aria-label="zoom in">+</button>
        <button type="button" onClick={() => zoomAt(size.width / 2, size.height / 2, 1 / ZOOM_STEP)} aria-label="zoom out">−</button>
        <button type="button" onClick={() => fit()}>fit</button>
        <span className="zoom-level">{Math.round(viewport.k * 100)}%</span>
      </div>
      <Minimap layout={layout} size={size} viewport={viewport} onCenter={centerOn} />
    </div>
  );
}
