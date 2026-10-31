/**
 * planning_update.md P24/D §3.6 and P25 §3.4.1 (F-lite): the inherited-graph loader.
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
 *
 * F-lite adds one derived field to a copied finding body: the source run's current accepted rating chain, executed links only.
 * It is read from the source's ledger/case views, never written back, never merged into this run's canonical chain, and a rating
 * that is missing or not current is named by `chainOmitted` instead of guessed.
 */
import { join } from 'node:path';
import { isTypedCapability, describeCapability, type Capability } from '../capabilities.js';
import { caseViews } from '../cases.js';
import { indexRecords } from '../records.js';
import { LEDGER_BYTES } from '../records.js';
import type { CaseChain } from '../case-types.js';
import type { CaseEffect } from '../cvss.js';
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
/** F-lite bounds: six executed links, 160-char step text, and a 1 KiB chain block inside the existing 2 KiB body cap. */
export const INHERIT_CHAIN_STEPS = 6;
export const INHERIT_CHAIN_CHARS = 160;
export const INHERIT_CHAIN_BYTES = 1024;
/** Why a copied finding carries no chain. The caller never infers a chain from prose, a different run or an older revision. */
export const INHERIT_CHAIN_OMITTED = {
  bytes: 'bytes', noCase: 'no-current-case-record', notAccepted: 'not-current-accepted',
  ratingStale: 'rating-not-current', noChain: 'no-rated-chain',
} as const;
export type InheritChainOmitted = typeof INHERIT_CHAIN_OMITTED[keyof typeof INHERIT_CHAIN_OMITTED];

/** The plan's copy priority: what a later run is most likely to cite first. Origin is last because every run already has one. */
const INHERIT_KIND_ORDER: readonly ExplorationNodeKind[] = ['finding', 'fact', 'link', 'intent', 'goal', 'digest', 'origin'];
const clip = (value: string, max: number): string => value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
const newestFirst = (left: ExplorationNodeRow, right: ExplorationNodeRow): number =>
  right.updatedSequence - left.updatedSequence || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** The bounded body a copy carries: a body over 2 KiB keeps a label and its original size, never a truncated JSON fragment. */
function recapBody(node: ExplorationNodeRow): Record<string, unknown> {
  const raw = JSON.stringify(node.body), bytes = Buffer.byteLength(raw);
  if (bytes <= INHERIT_NODE_BYTES) return node.body;
  const window = record(node.body.window), text = typeof node.body.text === 'string' ? clip(node.body.text, 300) : undefined;
  return { inheritedSummary: clip(explorationNodeText(node), 200), originalBytes: bytes, ...(window ? { window } : {}), ...(text ? { text } : {}) };
}

/** F-lite: one executed link of the source rating, as plain strings that a later run can read without the source store. */
export interface InheritedChainStep {
  order: number; step: string; claimRef?: string; effect?: CaseEffect; gained: string[]; needs: string[];
}
export interface InheritedChainSummary {
  objective: string; demonstratedThrough?: number; impact?: { score: number; severity: string; effect: string };
  totalSteps: number; steps: InheritedChainStep[]; omittedLinks: number;
}
/** One finding's inherited chain: the summary itself, or the recorded reason the source supplied none. */
export type InheritedChainCopy = { chain: InheritedChainSummary } | { reason: string };
export interface InheritedChainCopies { copies: ReadonlyMap<string, InheritedChainCopy>; summaries: number }
/** The case fields a chain copy reads; `CaseView` satisfies it structurally, so a test can name only the deciding fields. */
export interface InheritChainSource {
  id: string; revision: number; reviewStatus?: string; verdict?: string; duplicateOf?: string;
  acceptedFinding?: boolean; ratingCurrent?: boolean; ratedRevision?: number;
  finding?: { chain?: CaseChain };
}

const typedTexts = (caps: readonly Capability[]): string[] =>
  [...new Set(caps.filter(isTypedCapability).map(describeCapability))].slice(0, 4);

/**
 * F-lite: only the executed prefix the rating records is copied, newest links first under the cap. A reasoned step after
 * `demonstratedThrough` is never copied, so it can never arrive in the next run looking executed.
 */
export function boundedChainSummary(chain: CaseChain): InheritedChainSummary {
  const through = chain.demonstratedThrough ?? 0, executed = chain.steps.slice(0, through);
  const shown = executed.slice(Math.max(0, executed.length - INHERIT_CHAIN_STEPS));
  const summary: InheritedChainSummary = {
    objective: clip(chain.objective, 120),
    ...(through >= 1 ? { demonstratedThrough: through } : {}),
    ...(chain.impact ? { impact: { score: chain.impact.score, severity: chain.impact.severity, effect: chain.impact.effect } } : {}),
    totalSteps: chain.steps.length,
    steps: shown.map(step => ({
      order: step.order, step: clip(step.step, INHERIT_CHAIN_CHARS), ...(step.claimRef ? { claimRef: step.claimRef } : {}),
      ...(step.effect ? { effect: step.effect } : {}), gained: typedTexts(step.gained), needs: typedTexts(step.needs),
    })),
    omittedLinks: executed.length - shown.length,
  };
  while (summary.steps.length && bytesOf(summary) > INHERIT_CHAIN_BYTES) { summary.steps = summary.steps.slice(1); summary.omittedLinks += 1; }
  return summary;
}

/**
 * The source run's chain copies: a case contributes only when its recorded review and rating agree. A schema-8 source is judged
 * with its live case context; the schema-7 fallback cannot rebuild asset currentness from records, so it accepts the case's own
 * recorded acceptance and a rating pinned to the same revision, and nothing more.
 */
export function chainCopies(views: readonly InheritChainSource[], allowUnverifiedCurrentness = false): InheritedChainCopies {
  const copies = new Map<string, InheritedChainCopy>();
  for (const view of views) {
    const chain = view.finding?.chain;
    if (!chain) { copies.set(view.id, { reason: INHERIT_CHAIN_OMITTED.noChain }); continue; }
    const accepted = view.acceptedFinding === true
      || (allowUnverifiedCurrentness && view.reviewStatus === 'accepted' && view.verdict === 'confirmed' && view.duplicateOf === undefined);
    if (!accepted) { copies.set(view.id, { reason: INHERIT_CHAIN_OMITTED.notAccepted }); continue; }
    const current = view.ratingCurrent === true || (allowUnverifiedCurrentness && view.ratedRevision === view.revision);
    if (!current) { copies.set(view.id, { reason: INHERIT_CHAIN_OMITTED.ratingStale }); continue; }
    copies.set(view.id, { chain: boundedChainSummary(chain) });
  }
  return { copies, summaries: [...copies.values()].filter(copy => 'chain' in copy).length };
}

/** Add the chain, or its recorded omission reason, without ever exceeding the 2 KiB body cap. */
function attachChain(node: ExplorationNodeRow, body: Record<string, unknown>, copy: InheritedChainCopy | undefined): Record<string, unknown> {
  if (!copy) return body;
  if ('reason' in copy) return chainLabelled(node, body, copy.reason);
  const candidate = { ...body, chain: copy.chain };
  return bytesOf(candidate) <= INHERIT_NODE_BYTES ? candidate : chainLabelled(node, body, INHERIT_CHAIN_OMITTED.bytes);
}
function chainLabelled(node: ExplorationNodeRow, body: Record<string, unknown>, reason: string): Record<string, unknown> {
  const marked = { ...body, chainOmitted: reason };
  if (bytesOf(marked) <= INHERIT_NODE_BYTES) return marked;
  // The body was already at the cap: keep a deterministic label rather than dropping the reason that says why.
  return { inheritedSummary: clip(explorationNodeText(node), 200), originalBytes: bytesOf(body), chainOmitted: reason };
}

/**
 * Trim one referenced run's projection to the copy budget. Nodes are copied by priority (then newest first); edges and anchors
 * are copied only when both/all endpoints are in the kept set, so an imported edge never points at a row this run does not have.
 */
export function trimInheritedRun(runId: string, projection: ExplorationProjection,
  options: { nodes?: number; edges?: number; anchors?: number; chains?: ReadonlyMap<string, InheritedChainCopy> } = {}): InheritedGraphSource {
  const nodeBudget = options.nodes ?? INHERIT_NODES, edgeBudget = options.edges ?? INHERIT_EDGES, anchorBudget = options.anchors ?? INHERIT_ANCHORS;
  const own = projection.nodes.filter(node => node.inheritedFrom === undefined);
  const kept: ExplorationNodeRow[] = [];
  for (const kind of INHERIT_KIND_ORDER) {
    for (const node of own.filter(item => item.kind === kind).sort(newestFirst)) {
      if (kept.length >= nodeBudget) break;
      const body = recapBody(node);
      // A map is the collector saying it looked: a finding absent from it has no current case record, never a silent empty chain.
      const copy = node.kind === 'finding' && options.chains ? options.chains.get(node.entityId) ?? { reason: INHERIT_CHAIN_OMITTED.noCase } : undefined;
      kept.push({ ...node, body: options.chains ? attachChain(node, body, copy) : body, inheritedFrom: runId, sourceNodeId: node.id });
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
export interface InheritedCollection { sources: InheritedGraphSource[]; skipped: string[]; chains: number }

interface PriorRead { projection: ExplorationProjection; chains: ReadonlyMap<string, InheritedChainCopy> }

/**
 * Read each selected run's projection and trim it. A schema-8 store is read through `explorationSnapshot()` plus its ledger (for
 * the F-lite chain copies); a schema-7 run is read through the raw read-only reader and its graph derived from `records`, so
 * cross-run reuse keeps working across the schema boundary without rewriting the old store. A run that cannot be read is
 * skipped by name, never guessed at.
 */
export async function collectInheritedGraph(root: string, candidates: readonly InheritCandidate[], options: { maxBytes: number }): Promise<InheritedCollection> {
  const sources: InheritedGraphSource[] = [], skipped: string[] = [];
  let chains = 0;
  for (const candidate of candidates.slice(0, INHERIT_RUNS)) {
    try {
      const prior = priorRead(root, candidate, options);
      sources.push(trimInheritedRun(candidate.runId, prior.projection, { chains: prior.chains }));
      chains += [...prior.chains.values()].filter(copy => 'chain' in copy).length;
    } catch { skipped.push(candidate.runId); }
  }
  return { sources, skipped, chains };
}

function priorRead(root: string, candidate: InheritCandidate, options: { maxBytes: number }): PriorRead {
  let store: AssessmentStore | undefined;
  try { store = AssessmentStore.open(root, candidate.runId, { readOnly: true, maxBytes: options.maxBytes }); } catch { store = undefined; }
  if (store) {
    try {
      if (store.compatible) {
        const snapshot = store.explorationSnapshot();
        const index = indexRecords(store.records(), candidate.runId);
        const { copies } = chainCopies(caseViews(index, store.reviewContext().cases));
        return { projection: { nodes: snapshot.nodes, edges: snapshot.edges, anchors: snapshot.anchors, unresolved: snapshot.unresolved,
          overflow: snapshot.overflow, chainOrderTruncated: snapshot.chainOrderTruncated }, chains: copies };
      }
    } finally { store.close(); }
  }
  const legacy = readRecordsReadOnly(join(root, candidate.runId, 'assessment.sqlite'), { maxBytes: Math.min(options.maxBytes, LEDGER_BYTES) });
  const origin = { runId: legacy.runId, targetKind: legacy.manifest.targetKind, targetIdentityHash: sha256Hex(legacy.manifest.targetIdentity),
    targetDisplay: legacy.manifest.targetDisplay, ...(legacy.manifest.profile?.mode ? { mode: legacy.manifest.profile.mode } : {}) };
  const projection = deriveExploration({ records: legacy.records.map((row, index) => ({ record: row, sequence: index + 1 })), origin });
  const { copies } = chainCopies(caseViews(indexRecords(legacy.records, legacy.runId), {}), true);
  return { projection, chains: copies };
}
