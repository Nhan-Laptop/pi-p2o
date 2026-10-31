/**
 * planning_update.md P24/D §3.6: the inherited-graph loader.
 *
 * A run that was started with `--refer-workspace` already selected prior stored runs on the same target; this module turns that
 * selection into a bounded, labeled copy set for this run's exploration projection. It never adds a discovery path: the
 * candidates come from the caller's `priorRunsOnTarget` selection, and nothing is copied unless the operator opted in.
 *
 * Two properties are load-bearing and are asserted by the tests:
 * - **Bounded**: newest `INHERIT_RUNS` referenced runs; per run at most `INHERIT_NODES` nodes (priority findings → facts → links
 *   → intents → goals → digests) and `INHERIT_EDGES` edges, an edge only when both endpoints were copied; a body over
 *   `INHERIT_NODE_BYTES` keeps a one-line label and its original size instead of a truncated JSON fragment.
 * - **Inert**: every copied row is marked `inherited_from`/`source_node_id`; the store's projection rules read only rows
 *   without the marker, so an imported row satisfies no readiness, proof, rating, coverage or digest window. Only a count line
 *   and an explicitly labeled read page ever show it.
 */
import { join } from 'node:path';
import { LEDGER_BYTES } from '../records.js';
import { deriveExploration, explorationNodeText, type ExplorationNodeKind, type ExplorationNodeRow, type ExplorationProjection,
  type InheritedGraphSource } from '../exploration-graph.js';
import { sha256Hex } from '../validate.js';
import { readRecordsReadOnly } from './legacy.js';
import { AssessmentStore, type StoreManifest } from './store.js';

export const INHERIT_RUNS = 2;
export const INHERIT_NODES = 400;
export const INHERIT_EDGES = 800;
export const INHERIT_ANCHORS = 400;
export const INHERIT_NODE_BYTES = 2 * 1024;
/** The plan's copy priority: what a later run is most likely to cite first. Origin is last because every run already has one. */
const INHERIT_KIND_ORDER: readonly ExplorationNodeKind[] = ['finding', 'fact', 'link', 'intent', 'goal', 'digest', 'origin'];
const clip = (value: string, max: number): string => value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
const newestFirst = (left: ExplorationNodeRow, right: ExplorationNodeRow): number =>
  right.updatedSequence - left.updatedSequence || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The bounded body a copy carries: a body over 2 KiB keeps a label and its original size, never a truncated JSON fragment. */
function recapBody(node: ExplorationNodeRow): Record<string, unknown> {
  const raw = JSON.stringify(node.body), bytes = Buffer.byteLength(raw);
  if (bytes <= INHERIT_NODE_BYTES) return node.body;
  const window = record(node.body.window), text = typeof node.body.text === 'string' ? clip(node.body.text, 300) : undefined;
  return { inheritedSummary: clip(explorationNodeText(node), 200), originalBytes: bytes, ...(window ? { window } : {}), ...(text ? { text } : {}) };
}

/**
 * Trim one referenced run's projection to the copy budget. Nodes are copied by priority (then newest first); edges and anchors
 * are copied only when both/all endpoints are in the kept set, so an imported edge never points at a row this run does not have.
 */
export function trimInheritedRun(runId: string, projection: ExplorationProjection,
  options: { nodes?: number; edges?: number; anchors?: number } = {}): InheritedGraphSource {
  const nodeBudget = options.nodes ?? INHERIT_NODES, edgeBudget = options.edges ?? INHERIT_EDGES, anchorBudget = options.anchors ?? INHERIT_ANCHORS;
  const own = projection.nodes.filter(node => node.inheritedFrom === undefined);
  const kept: ExplorationNodeRow[] = [];
  for (const kind of INHERIT_KIND_ORDER) {
    for (const node of own.filter(item => item.kind === kind).sort(newestFirst)) {
      if (kept.length >= nodeBudget) break;
      kept.push({ ...node, body: recapBody(node), inheritedFrom: runId, sourceNodeId: node.id });
    }
    if (kept.length >= nodeBudget) break;
  }
  const ids = new Set(kept.map(node => node.id));
  return {
    runId,
    nodes: kept,
    edges: projection.edges.filter(edge => edge.inheritedFrom === undefined && ids.has(edge.srcId) && ids.has(edge.dstId))
      .slice(0, edgeBudget).map(edge => ({ ...edge, inheritedFrom: runId })),
    anchors: projection.anchors.filter(anchor => anchor.inheritedFrom === undefined && ids.has(anchor.nodeId))
      .slice(0, anchorBudget).map(anchor => ({ ...anchor, inheritedFrom: runId })),
  };
}

/** One referenced run as the caller selected it: the run id and the manifest `priorRunsOnTarget` already matched. */
export interface InheritCandidate { runId: string; manifest: StoreManifest }
export interface InheritedCollection { sources: InheritedGraphSource[]; skipped: string[] }

/**
 * Read each selected run's projection and trim it. A schema-8 store is read through `explorationSnapshot()`; a schema-7 run is
 * read through the raw read-only reader and its graph derived from `records`, so cross-run reuse keeps working across the schema
 * boundary without rewriting the old store. A run that cannot be read is skipped by name, never guessed at.
 */
export async function collectInheritedGraph(root: string, candidates: readonly InheritCandidate[], options: { maxBytes: number }): Promise<InheritedCollection> {
  const sources: InheritedGraphSource[] = [], skipped: string[] = [];
  for (const candidate of candidates.slice(0, INHERIT_RUNS)) {
    try { sources.push(trimInheritedRun(candidate.runId, priorProjection(root, candidate, options))); }
    catch { skipped.push(candidate.runId); }
  }
  return { sources, skipped };
}

function priorProjection(root: string, candidate: InheritCandidate, options: { maxBytes: number }): ExplorationProjection {
  let store: AssessmentStore | undefined;
  try { store = AssessmentStore.open(root, candidate.runId, { readOnly: true, maxBytes: options.maxBytes }); } catch { store = undefined; }
  if (store) {
    try {
      if (store.compatible) {
        const snapshot = store.explorationSnapshot();
        return { nodes: snapshot.nodes, edges: snapshot.edges, anchors: snapshot.anchors, unresolved: snapshot.unresolved, overflow: snapshot.overflow,
          chainOrderTruncated: snapshot.chainOrderTruncated };
      }
    } finally { store.close(); }
  }
  const legacy = readRecordsReadOnly(join(root, candidate.runId, 'assessment.sqlite'), { maxBytes: Math.min(options.maxBytes, LEDGER_BYTES) });
  const origin = { runId: legacy.runId, targetKind: legacy.manifest.targetKind, targetIdentityHash: sha256Hex(legacy.manifest.targetIdentity),
    targetDisplay: legacy.manifest.targetDisplay, ...(legacy.manifest.profile?.mode ? { mode: legacy.manifest.profile.mode } : {}) };
  return deriveExploration({ records: legacy.records.map((row, index) => ({ record: row, sequence: index + 1 })), origin });
}
