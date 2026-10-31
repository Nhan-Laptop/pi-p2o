/**
 * planning_update.md P24 (§3.1-§3.4): the persisted exploration graph is a **projection**, never an authority.
 *
 * Every row here is derived by the host from committed ledger records plus the closed rules below. There is no tool that
 * writes a node or an edge, the graph satisfies nothing (readiness, goal proof, case rating, coverage and completion keep
 * reading records), and deleting the rows and rebuilding them from `records` reproduces them byte for byte. That invariant is
 * what the differential test in `tests/minimal/exploration-graph.test.ts` pins.
 *
 * Two consumers share the rules in this module: `deriveExploration()` is the complete, in-memory oracle the rebuild path and
 * the tests use, while `explorationDelta()` is the bounded per-record projection the store applies on commit. `proves` edges
 * are evaluated from both ends (§3.4.1) because either end may be committed last, so a goal committed after its facts and a
 * fact committed after its goal produce the same edge from the same rule.
 */
import { capabilityList, capabilityMatches, isTypedCapability, type Capability } from './capabilities.js';
import { claimCapabilities, isDemonstrated } from './claims.js';
import { parseCampaign } from './campaign.js';
import { TERMINAL_EXECUTION } from './goal-proof.js';
import type { AssessmentRecord } from './records.js';
import { graphCanonical } from './state/graph.js';
import { sha256Hex, validId } from './validate.js';

export const EXPLORATION_GRAPH_VERSION = 1 as const;
export const EXPLORATION_NODE_KINDS = ['origin', 'goal', 'link', 'intent', 'fact', 'finding', 'digest'] as const;
export type ExplorationNodeKind = typeof EXPLORATION_NODE_KINDS[number];
/** Parent→child, as in ARTEX (`agent/coldgraph.go:11-13`); the digest's `covers` is the only member edge. */
export const EXPLORATION_RELATIONS = ['spawns', 'derived_from', 'yields', 'proves', 'covers'] as const;
export type ExplorationRelation = typeof EXPLORATION_RELATIONS[number];
/** Closed state vocabulary per kind. A row whose state is outside it is refused by the store, never read as "unknown". */
export const EXPLORATION_STATES: Readonly<Record<ExplorationNodeKind, readonly string[]>> = {
  origin: ['current'],
  goal: ['proposed', 'active', 'met', 'reviewed', 'closed', 'blocked', 'cancelled'],
  link: ['open', 'in-progress', 'done', 'deferred', 'blocked', 'cancelled'],
  intent: ['proposed', 'reserved', 'running', 'reported', 'reviewed', 'closed', 'blocked', 'cancelled', 'expired'],
  fact: ['demonstrated', 'confirmed', 'open_proof_gap', 'ruled_out', 'unknown'],
  finding: ['pending', 'accepted', 'disputed', 'withdrawn'],
  digest: ['active', 'superseded'],
};
export const EXPLORATION_NODE_LIMIT = 4000;
export const EXPLORATION_EDGE_LIMIT = 8000;
export const EXPLORATION_ANCHOR_LIMIT = 8000;
/** A node body is a bounded projection, never an evidence carrier; the ledger row it names keeps the full record. */
export const EXPLORATION_NODE_BYTES = 8 * 1024;
/** §3.4.1 bounds: a commit scans at most these many goals/sources before leaving an honest `provesTruncated` mark. */
export const PROVES_GOAL_SCAN = 200;
export const PROVES_FACT_SCAN = 500;
/** Inline references in a node body. A record may cite more; the graph keeps its bounded head, the record keeps all. */
const INLINE_REFS = 10;

export interface ExplorationNodeRow {
  id: string; kind: ExplorationNodeKind; state: string; entityId: string;
  recordId?: string; sequence: number; createdSequence: number; updatedSequence: number;
  body: Record<string, unknown>;
  /** Set on every imported row (§3.6). Absent on a row this run derived. */
  inheritedFrom?: string;
  /** The prior run's node this copy came from, so two copies are never silently merged. */
  sourceNodeId?: string;
}
export interface ExplorationEdgeRow {
  srcId: string; rel: ExplorationRelation; dstId: string; sequence: number;
  inheritedFrom?: string;
}
export interface ExplorationAnchorRow { nodeId: string; assetEntity: string; sequence: number; inheritedFrom?: string }
export interface ExplorationProjection {
  nodes: ExplorationNodeRow[]; edges: ExplorationEdgeRow[]; anchors: ExplorationAnchorRow[];
  /** Edge/anchor targets the projection could not resolve; never fabricated as placeholder nodes. */
  unresolved: number;
  /** Rows the caps refused. Kept so a bounded read can say the projection stopped rather than imply completeness. */
  overflow: number;
}
export interface ExplorationSnapshot extends ExplorationProjection {
  version: 1; runId: string; asOfSequence: number;
  counts: { nodes: number; edges: number; anchors: number };
}
export interface RecordedRow { record: AssessmentRecord; sequence: number }
/** Run-manifest identity the origin root is built from; the campaign frame adds the objective when one is recorded. */
export interface ExplorationOrigin {
  runId: string; targetKind: string; targetIdentityHash: string; targetDisplay: string;
  mode?: string; objective?: string;
}

/** §3.1 deterministic identity: the same record packet yields the same node id on every replay and rebuild. */
export function explorationNodeId(kind: ExplorationNodeKind, runId: string, entityId: string): string {
  return `${kind}-${sha256Hex(`${runId}\u0000${kind}\u0000${entityId}`).slice(0, 24)}`;
}
/** §3.5: a digest is one node per round; the plan fixes the id shape so a read can address it without a lookup. */
export function digestNodeId(runId: string, round: number): string {
  return `digest-${runId.slice(0, 8)}-${round}`;
}
export function isExplorationState(kind: ExplorationNodeKind, state: string): boolean {
  return EXPLORATION_STATES[kind].includes(state);
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const clip = (value: unknown, max: number): string | undefined => typeof value === 'string' ? value.slice(0, max) : undefined;
const text = (value: unknown, max: number): string | undefined => { const item = clip(value, max); return item !== undefined && item.trim().length ? item : undefined; };
const ids = (value: unknown, max = INLINE_REFS): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => validId(item)).slice(0, max) : [];
function capabilities(value: unknown): Capability[] {
  if (!Array.isArray(value) || !value.length) return [];
  try { return capabilityList(value.slice(0, INLINE_REFS), 'exploration capability'); } catch { return []; }
}
/** A plan row names its tasks as bare ids; a task/case names them as `{taskId}` references. Both forms have one reader each. */
function stringIds(value: unknown, max = INLINE_REFS): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => validId(item)).slice(0, max);
}
function taskIds(value: unknown, max = INLINE_REFS): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const entry of value.slice(0, max)) {
    const taskId = object(entry)?.taskId;
    if (validId(taskId) && !result.includes(taskId)) result.push(taskId);
  }
  return result;
}
function assetRefs(value: unknown): Array<{ id: string }> {
  if (!Array.isArray(value)) return [];
  const result: Array<{ id: string }> = [];
  for (const entry of value.slice(0, INLINE_REFS)) {
    const id = object(entry)?.id;
    if (validId(id) && !result.some(ref => ref.id === id)) result.push({ id });
  }
  return result;
}

type GoalProof = { kind: 'capability'; capability: Capability } | { kind: 'case' | 'coverage'; ref: string };
function goalProof(value: unknown): GoalProof | undefined {
  const row = object(value);
  if (!row) return undefined;
  if (row.kind === 'capability') {
    const parsed = capabilities([row.capability])[0];
    return parsed ? { kind: 'capability', capability: parsed } : undefined;
  }
  if ((row.kind === 'case' || row.kind === 'coverage') && validId(row.ref)) return { kind: row.kind, ref: row.ref };
  return undefined;
}

/**
 * The bounded context a rule may read. The store implements it over SQL; the complete derivation implements it over the rows
 * it has already applied, so both apply exactly the same rules.
 */
export interface ExplorationLookup {
  node(kind: ExplorationNodeKind, entityId: string): ExplorationNodeRow | undefined;
  /** Newest nodes of the given kinds, highest `updated_sequence` first, ties by ascending id. */
  nodes(kinds: readonly ExplorationNodeKind[], limit: number, state?: string): ExplorationNodeRow[];
  /** Candidate record id → claim slug, so a superseded record still resolves to the claim head (§3.4 `derived_from`). */
  claimSlug(recordId: string): string | undefined;
  /** Head `note` record of an entity id, used by the coverage-proof evaluation (§3.4.1). */
  headNote(entityId: string): AssessmentRecord | undefined;
  /** Goals whose proof has not been satisfied yet, newest first, bounded by the caller in `explorationDelta`. */
  goalsWithoutProves(limit: number): ExplorationNodeRow[];
}
export interface ExplorationDelta { nodes: ExplorationNodeRow[]; edges: ExplorationEdgeRow[]; anchors: ExplorationAnchorRow[]; unresolved: number }
export interface ExplorationDeltaInput {
  record: AssessmentRecord; sequence: number; runId: string; origin: ExplorationOrigin; lookup: ExplorationLookup;
}

/** §3.4.1: a coverage-plan proof writes no edge; the goal body records that its proof is a coverage one that holds now. */
function coverageHolds(ref: string, lookup: ExplorationLookup): boolean {
  const plan = object(lookup.headNote(ref)?.data?.coveragePlan);
  const cells = ids(plan?.cellIds, 400);
  if (!cells.length) return false;
  let live = 0;
  for (const id of cells) {
    const cell = object(lookup.headNote(id)?.data?.coverageCell);
    if (!cell || cell.retired === true) continue;
    live += 1;
    if (!TERMINAL_EXECUTION.has(String(cell.execution))) return false;
  }
  return live > 0;
}
function originBody(origin: ExplorationOrigin): Record<string, unknown> {
  return { targetKind: text(origin.targetKind, 20) ?? 'unknown', targetIdentityHash: text(origin.targetIdentityHash, 64) ?? '',
    targetDisplay: text(origin.targetDisplay, 200) ?? '', ...(text(origin.mode, 20) ? { mode: text(origin.mode, 20) } : {}),
    ...(text(origin.objective, 600) ? { objective: text(origin.objective, 600) } : {}), graphVersion: EXPLORATION_GRAPH_VERSION };
}
function factGained(row: ExplorationNodeRow): Capability[] { return capabilities(object(row.body)?.gained); }
/** The bounded body every node carries; a body that would exceed the bound is refused rather than silently shortened. */
function boundedBody(body: Record<string, unknown>): Record<string, unknown> {
  if (Buffer.byteLength(graphCanonical(body)) > EXPLORATION_NODE_BYTES) throw Error('Exploration node body exceeds the 8 KiB bound');
  return body;
}
const stateOf = (kind: ExplorationNodeKind, value: unknown, fallback: string): string => {
  const state = text(value, 40) ?? fallback;
  return isExplorationState(kind, state) ? state : fallback;
};

/**
 * The projection of exactly one committed record. Every rule is a pure function of the record, the sequence and the bounded
 * lookup, so the store's incremental write and the complete derivation cannot disagree about a row.
 */
export function explorationDelta(input: ExplorationDeltaInput): ExplorationDelta {
  const { record, sequence, runId, origin, lookup } = input;
  const nodes = new Map<string, ExplorationNodeRow>();
  const edges = new Map<string, ExplorationEdgeRow>();
  const anchors = new Map<string, ExplorationAnchorRow>();
  let unresolved = 0;

  const nodeIdOf = (kind: ExplorationNodeKind, entityId: string) => explorationNodeId(kind, runId, entityId);
  const resolve = (kind: ExplorationNodeKind, entityId: string): string | undefined => {
    const id = nodeIdOf(kind, entityId);
    return nodes.has(id) || lookup.node(kind, entityId) ? id : undefined;
  };
  const addNode = (row: ExplorationNodeRow): void => { nodes.set(row.id, { ...row, body: boundedBody(row.body) }); };
  const nodeFor = (kind: ExplorationNodeKind, entityId: string, state: string, body: Record<string, unknown>, recordId?: string): ExplorationNodeRow => {
    const id = nodeIdOf(kind, entityId), prior = nodes.get(id) ?? lookup.node(kind, entityId);
    return { id, kind, entityId, state, ...(recordId ?? prior?.recordId ? { recordId: recordId ?? prior!.recordId! } : {}),
      sequence, createdSequence: prior?.createdSequence ?? sequence, updatedSequence: sequence, body };
  };
  const addEdge = (srcKind: ExplorationNodeKind, srcEntity: string, rel: ExplorationRelation, dstKind: ExplorationNodeKind, dstEntity: string): void => {
    const srcId = resolve(srcKind, srcEntity), dstId = resolve(dstKind, dstEntity);
    if (!srcId || !dstId) { unresolved += 1; return; }
    const key = `${srcId}\u0000${rel}\u0000${dstId}`;
    if (!edges.has(key)) edges.set(key, { srcId, rel, dstId, sequence });
  };
  const addAnchor = (nodeId: string | undefined, assetEntity: string): void => {
    if (!nodeId) { unresolved += 1; return; }
    const key = `${nodeId}\u0000${assetEntity}`;
    if (!anchors.has(key)) anchors.set(key, { nodeId, assetEntity, sequence });
  };
  /** The claim slug a reference names: a record id resolves through its candidate row, a slug is already the identity. */
  const slugOf = (ref: string): string => lookup.claimSlug(ref) ?? ref;

  const originId = nodeIdOf('origin', runId);
  const ensureOrigin = (extra?: { objective?: string; mode?: string }): void => {
    const prior = nodes.get(originId) ?? lookup.node('origin', runId);
    if (!prior) addNode({ id: originId, kind: 'origin', entityId: runId, state: 'current', sequence,
      createdSequence: sequence, updatedSequence: sequence, body: originBody({ ...origin, ...extra }) });
    else if (extra) addNode(nodeFor('origin', runId, 'current', originBody({ ...origin, ...extra }), prior.recordId));
  };
  // The origin root exists from the first committed record, so every later node has a lineage root even without a campaign row.
  ensureOrigin();
  if (record.kind === 'lifecycle') {
    const campaign = parseCampaign(object(record.data)?.campaign);
    if (campaign) ensureOrigin({ objective: campaign.objective, mode: campaign.mode });
  }

  // ---- note: goal, link and finding revisions ----------------------------------------------------------------
  if (record.kind === 'note') {
    const plan = object(record.data?.plan);
    if (plan && validId(plan.id)) {
      if (plan.kind === 'goal') {
        const proof = goalProof(plan.proof), prior = lookup.node('goal', plan.id);
        let state = stateOf('goal', plan.status, 'proposed');
        const body: Record<string, unknown> = { planId: plan.id, revision: plan.revision, status: text(plan.status, 40) ?? 'proposed',
          ...(text(plan.title, 200) ? { title: text(plan.title, 200) } : {}), ...(proof ? { proof } : {}) };
        const sources: Array<{ kind: ExplorationNodeKind; entityId: string }> = [];
        if (proof?.kind === 'capability') {
          // §3.4.1: the goal side scans the newest demonstrated facts; overflow is marked, never guessed as unmet. One edge is
          // written — the newest source that satisfies the proof — so many demonstrations of one capability do not fan in.
          const scanned = lookup.nodes(['fact'], PROVES_FACT_SCAN + 1, 'demonstrated'), truncated = scanned.length > PROVES_FACT_SCAN;
          const matched = scanned.slice(0, PROVES_FACT_SCAN).find(fact => factGained(fact).some(gained => capabilityMatches(gained, proof.capability)));
          if (matched) { sources.push({ kind: 'fact', entityId: matched.entityId }); state = 'met'; }
          else if (truncated) body.provesTruncated = true;
        } else if (proof?.kind === 'case') {
          const finding = lookup.node('finding', proof.ref);
          if (finding && finding.state === 'accepted' && object(finding.body)?.verdict === 'confirmed') sources.push({ kind: 'finding', entityId: proof.ref });
          if (sources.length) state = 'met';
        } else if (proof?.kind === 'coverage' && coverageHolds(proof.ref, lookup)) body.proofHolds = 'coverage';
        // A revision that no longer satisfies its proof drops `met`; the older edge stays as history, exactly like a ledger row.
        if (!sources.length && prior?.state === 'met' && state !== 'met') state = stateOf('goal', plan.status, 'proposed');
        addNode(nodeFor('goal', plan.id, state, body, record.id));
        addEdge('origin', runId, 'spawns', 'goal', plan.id);
        for (const source of sources) addEdge(source.kind, source.entityId, 'proves', 'goal', plan.id);
      } else if (plan.kind === 'todo') {
        const chainOf = text(plan.chainOf, 80), step = typeof plan.step === 'number' && Number.isInteger(plan.step) && plan.step > 0 ? plan.step : undefined;
        // Only a chain row is a `link`; an ordinary todo is planning, and inventing a link node for it would misreport the chain.
        if (chainOf && step) {
          const claimRefs = ids(plan.claimRefs);
          addNode(nodeFor('link', plan.id, stateOf('link', plan.status, 'open'), { planId: plan.id, revision: plan.revision, chainOf, step,
            status: text(plan.status, 40) ?? 'open', ...(text(plan.title, 200) ? { title: text(plan.title, 200) } : {}),
            ...(text(plan.effect, 40) ? { effect: text(plan.effect, 40) } : {}), ...(claimRefs.length ? { claimRefs } : {}),
            ...(Array.isArray(plan.needs) && plan.needs.length ? { needs: capabilities(plan.needs) } : {}) }, record.id));
          for (const ref of claimRefs) addEdge('fact', slugOf(ref), 'derived_from', 'link', plan.id);
          for (const taskId of stringIds(plan.taskIds)) addEdge('link', plan.id, 'derived_from', 'intent', taskId);
        }
      }
    }
    const caseEntry = object(record.data?.case);
    if (caseEntry && validId(caseEntry.id)) {
      const reviewStatus = stateOf('finding', caseEntry.reviewStatus, 'pending'), evidence = object(caseEntry.finding);
      addNode(nodeFor('finding', caseEntry.id, reviewStatus, { caseId: caseEntry.id, revision: caseEntry.revision, reviewStatus,
        verdict: text(caseEntry.verdict, 20) ?? 'open', ...(text(evidence?.severity, 20) ? { severity: text(evidence?.severity, 20) } : {}),
        ...(text(caseEntry.title, 200) ? { title: text(caseEntry.title, 200) } : {}), claimRefs: ids(caseEntry.claimRefs), taskRefs: taskIds(caseEntry.taskRefs) }, record.id));
      // The case stands on its claims: fact → finding, and the work that produced it: intent → finding.
      for (const taskId of taskIds(caseEntry.taskRefs)) addEdge('intent', taskId, 'yields', 'finding', caseEntry.id);
      for (const ref of ids(caseEntry.claimRefs)) addEdge('fact', slugOf(ref), 'derived_from', 'finding', caseEntry.id);
      if (reviewStatus === 'accepted' && caseEntry.verdict === 'confirmed') {
        for (const goal of lookup.goalsWithoutProves(PROVES_GOAL_SCAN + 1).slice(0, PROVES_GOAL_SCAN)) {
          const proof = goalProof(object(goal.body)?.proof);
          if (proof?.kind !== 'case' || proof.ref !== caseEntry.id) continue;
          addNode({ ...goal, state: 'met', sequence, updatedSequence: sequence });
          addEdge('finding', caseEntry.id, 'proves', 'goal', goal.entityId);
        }
      }
      for (const asset of assetRefs(caseEntry.assetRefs)) addAnchor(nodeIdOf('finding', caseEntry.id), asset.id);
    }
  }

  // ---- task: intent -------------------------------------------------------------------------------------------
  if (record.kind === 'task') {
    const task = object(record.data?.task);
    if (task && validId(task.id)) {
      const work = object(task.work), claimRefs = ids(work?.claimRefs), prerequisites = taskIds(task.prerequisites);
      const parentTaskId = validId(task.parentTaskId) ? task.parentTaskId : undefined;
      const validationOf = validId(task.validationOf) ? task.validationOf : undefined;
      const retestOf = validId(task.retestOf) ? task.retestOf : undefined;
      addNode(nodeFor('intent', task.id, stateOf('intent', task.status, 'proposed'), { taskId: task.id, revision: task.revision,
        ...(text(task.role, 40) ? { role: text(task.role, 40) } : {}), ...(text(work?.purpose, 40) ? { purpose: text(work?.purpose, 40) } : {}),
        status: text(task.status, 40) ?? 'proposed', claimRefs,
        ...(text(work?.methodFamily, 80) ? { methodFamily: text(work?.methodFamily, 80) } : {}),
        ...(text(task.question, 200) ? { title: text(task.question, 200) } : {}) }, record.id));
      // A task with no lineage is spawned by the run itself; anything else is derived from what it cites.
      const derived = [parentTaskId, validationOf, retestOf].filter((value): value is string => value !== undefined);
      if (!claimRefs.length && !prerequisites.length && !derived.length) addEdge('origin', runId, 'spawns', 'intent', task.id);
      for (const ref of claimRefs) addEdge('fact', slugOf(ref), 'derived_from', 'intent', task.id);
      for (const taskId of [...prerequisites, ...derived]) addEdge('intent', taskId, 'derived_from', 'intent', task.id);
      for (const asset of assetRefs(work?.assetRefs)) addAnchor(nodeIdOf('intent', task.id), asset.id);
    }
  }

  // ---- candidate: fact ----------------------------------------------------------------------------------------
  if (record.kind === 'candidate') {
    const data = object(record.data);
    if (data && typeof data.candidate === 'string' && data.candidate.length && record.id) {
      const slug = data.candidate, parsed = claimCapabilities(data), demonstrated = isDemonstrated(data);
      addNode(nodeFor('fact', slug, demonstrated ? 'demonstrated' : stateOf('fact', data.closure, 'unknown'), { slug, recordId: record.id,
        closure: text(data.closure, 40) ?? 'unknown', execution: text(data.execution, 40) ?? 'not_tested',
        gained: parsed.gained, needs: parsed.needs,
        ...(text(record.surface ?? data.surface, 80) ? { surface: text(record.surface ?? data.surface, 80) } : {}),
        ...(text(record.risk, 80) ? { risk: text(record.risk, 80) } : {}),
        ...(text(data.proof, 40) ? { proof: text(data.proof, 40) } : {}),
        ...(validId(data.taskRef) ? { taskRef: data.taskRef } : {}) }, record.id));
      if (validId(data.taskRef)) addEdge('intent', data.taskRef, 'yields', 'fact', slug);
      for (const asset of assetRefs(data.assetRefs)) addAnchor(nodeIdOf('fact', slug), asset.id);
      // §3.4.1 source side: a demonstrated fact may satisfy an already-recorded capability goal.
      if (demonstrated) for (const goal of lookup.goalsWithoutProves(PROVES_GOAL_SCAN + 1).slice(0, PROVES_GOAL_SCAN)) {
        const proof = goalProof(object(goal.body)?.proof);
        if (proof?.kind !== 'capability' || !parsed.gained.some(gained => capabilityMatches(gained, proof.capability))) continue;
        addNode({ ...goal, state: 'met', sequence, updatedSequence: sequence });
        addEdge('fact', slug, 'proves', 'goal', goal.entityId);
      }
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()], anchors: [...anchors.values()], unresolved };
}

const newestFirst = (left: ExplorationNodeRow, right: ExplorationNodeRow) =>
  right.updatedSequence - left.updatedSequence || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
const byText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** In-memory context for the complete derivation: the same interface the store implements over SQL. */
class MemoryLookup implements ExplorationLookup {
  private readonly byId = new Map<string, ExplorationNodeRow>();
  private readonly byEntity = new Map<string, ExplorationNodeRow>();
  private readonly notes = new Map<string, AssessmentRecord>();
  private readonly slugs = new Map<string, string>();
  private readonly edgeMap = new Map<string, ExplorationEdgeRow>();
  private readonly anchorMap = new Map<string, ExplorationAnchorRow>();
  node(kind: ExplorationNodeKind, entityId: string): ExplorationNodeRow | undefined { return this.byEntity.get(`${kind}\u0000${entityId}`); }
  nodes(kinds: readonly ExplorationNodeKind[], limit: number, state?: string): ExplorationNodeRow[] {
    return [...this.byId.values()].filter(row => kinds.includes(row.kind) && (state === undefined || row.state === state)).sort(newestFirst).slice(0, limit);
  }
  claimSlug(recordId: string): string | undefined { return this.slugs.get(recordId); }
  headNote(entityId: string): AssessmentRecord | undefined { return this.notes.get(entityId); }
  goalsWithoutProves(limit: number): ExplorationNodeRow[] {
    return [...this.byId.values()].filter(row => row.kind === 'goal' && row.state !== 'met'
      && object(row.body)?.proof !== undefined && object(row.body)?.proofHolds === undefined).sort(newestFirst).slice(0, limit);
  }
  apply(delta: ExplorationDelta, caps: { nodes: number; edges: number; anchors: number }): number {
    let overflow = 0;
    for (const row of delta.nodes) {
      if (!this.byId.has(row.id) && this.byId.size >= caps.nodes) { overflow += 1; continue; }
      this.byId.set(row.id, row); this.byEntity.set(`${row.kind}\u0000${row.entityId}`, row);
    }
    for (const edge of delta.edges) {
      if (!this.byId.has(edge.srcId) || !this.byId.has(edge.dstId)) { overflow += 1; continue; }
      const key = `${edge.srcId}\u0000${edge.rel}\u0000${edge.dstId}`;
      if (this.edgeMap.has(key)) continue;
      if (this.edgeMap.size >= caps.edges) { overflow += 1; continue; }
      this.edgeMap.set(key, edge);
    }
    for (const anchor of delta.anchors) {
      if (!this.byId.has(anchor.nodeId)) { overflow += 1; continue; }
      const key = `${anchor.nodeId}\u0000${anchor.assetEntity}`;
      if (this.anchorMap.has(key)) continue;
      if (this.anchorMap.size >= caps.anchors) { overflow += 1; continue; }
      this.anchorMap.set(key, anchor);
    }
    return overflow;
  }
  /** Indexes a record before the next delta reads it, exactly like the store's head-record and candidate-slug queries. */
  index(record: AssessmentRecord): void {
    const data = object(record.data);
    if (record.kind === 'note') for (const key of ['plan', 'case', 'coveragePlan', 'coverageCell'] as const) {
      const entry = object(data?.[key]);
      if (entry && validId(entry.id)) this.notes.set(entry.id, record);
    }
    if (record.kind === 'candidate' && record.id && typeof data?.candidate === 'string') this.slugs.set(record.id, data.candidate);
  }
  snapshot(unresolved: number, overflow: number): ExplorationProjection {
    return { nodes: [...this.byId.values()].sort((left, right) => left.updatedSequence - right.updatedSequence || byText(left.id, right.id)),
      edges: [...this.edgeMap.values()].sort((left, right) => left.sequence - right.sequence || byText(left.srcId, right.srcId) || byText(left.rel, right.rel) || byText(left.dstId, right.dstId)),
      anchors: [...this.anchorMap.values()].sort((left, right) => left.sequence - right.sequence || byText(left.nodeId, right.nodeId) || byText(left.assetEntity, right.assetEntity)),
      unresolved, overflow };
  }
}

const CAPS = { nodes: EXPLORATION_NODE_LIMIT, edges: EXPLORATION_EDGE_LIMIT, anchors: EXPLORATION_ANCHOR_LIMIT };
/** The complete derivation the rebuild path and the tests compare against; no clock, network or second run is read. */
export function deriveExploration(input: { records: readonly RecordedRow[]; origin: ExplorationOrigin; caps?: { nodes: number; edges: number; anchors: number } }): ExplorationProjection {
  const caps = input.caps ?? CAPS, state = new MemoryLookup();
  let unresolved = 0, overflow = 0;
  for (const { record, sequence } of input.records) {
    state.index(record);
    const delta = explorationDelta({ record, sequence, runId: input.origin.runId, origin: input.origin, lookup: state });
    unresolved += delta.unresolved;
    overflow += state.apply(delta, caps);
  }
  return state.snapshot(unresolved, overflow);
}
