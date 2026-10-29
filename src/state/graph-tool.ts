import { Type } from 'typebox';
import { choices } from '../schema-kit.js';
import { ASSET_KINDS, ANCHOR_KINDS, CONFIDENCE, FACT_KINDS, HYPOTHESIS_STATUS, RELATION_KINDS, graphCanonical, type AssetInput, type GraphBatch } from './graph.js';

const id = () => Type.String({ minLength: 1, maxLength: 80 });
const refs = () => Type.Optional(Type.Array(id(), { maxItems: 10 }));
const revision = () => Type.Optional(Type.Integer({ minimum: 1 }));
/** Optional IDs accept an empty string so a model that writes `supersedes:""` to mean "none" reaches the host, which drops it. */
const supersedes = () => Type.Optional(Type.String({ maxLength: 80 }));
const object = Type.Object;
const anchor = object({ kind: choices(ANCHOR_KINDS), value: Type.String({ minLength: 1, maxLength: 1000 }),
  locator: Type.Optional(Type.Record(Type.String({ maxLength: 64 }), Type.String({ maxLength: 500 }), { maxProperties: 8 })),
  artifactId: Type.Optional(id()), supersedes: supersedes() });
/**
 * A1 record-shape tolerance: the batch subtrees deliberately do not set `additionalProperties:false`. A model that places
 * `requestId` inside the batch, carries `evidenceRefs` on the asset row, or spells an asset flat is accepted here and folded
 * into the canonical shape by `normalizeGraphRecord`; the host still validates every row before any state mutation
 * (`graphObject`/`validateGraphBatch`), so unknown or producer-owned fields are refused with a message naming the fields
 * that are allowed instead of losing the whole call to Pi's argument validator. The root stays strict (batch/requestId).
 */
const assetFields = {
  kind: choices(ASSET_KINDS), key: Type.String({ minLength: 1, maxLength: 500 }),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), expectedRevision: revision(), evidenceRefs: refs(),
  attributes: Type.Optional(Type.Record(Type.String({ maxLength: 64 }), Type.String({ maxLength: 500 }), { maxProperties: 16 })),
  anchors: Type.Optional(Type.Array(anchor)),
};
const batch = object({
  assets: Type.Optional(Type.Array(object({ asset: Type.Optional(object(assetFields)), ref: Type.Optional(Type.String({ minLength: 1, maxLength: 32, pattern: '^[a-zA-Z][a-zA-Z0-9_-]*$' })) }))),
  facts: Type.Optional(Type.Array(object({ assetId: id(), assetRevision: revision(), kind: choices(FACT_KINDS),
    statement: Type.String({ minLength: 1, maxLength: 2000 }), confidence: choices(CONFIDENCE), evidenceRefs: refs(), supersedes: supersedes() }))),
  hypotheses: Type.Optional(Type.Array(object({ assetId: id(), assetRevision: revision(), statement: Type.String({ minLength: 1, maxLength: 2000 }),
    status: choices(HYPOTHESIS_STATUS), impact: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })), evidenceRefs: refs(), counterevidenceRefs: refs(), supersedes: supersedes() }))),
  relations: Type.Optional(Type.Array(object({ kind: choices(RELATION_KINDS), fromId: id(), toId: id(), fromRevision: revision(), toRevision: revision(),
    note: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })), evidenceRefs: refs(), basis: Type.Optional(choices(['observed','inferred'])),
    status: Type.Optional(choices(['active','withdrawn'])), supersedes: supersedes() }))),
  anchors: Type.Optional(Type.Array(object({ assetId: id(), assetRevision: revision(), anchor }))),
});

/**
 * S1/C1 split the one graph verb by authority. Reads stay in `p2o_graph` for planner, worker and validation; the batch write
 * moved to `p2o_graph_record` (worker/validation loadout), owner review to `p2o_graph_review` (planner) and the planner-only
 * coordination actions to `p2o_graph_plan`. The host field lists below are the per-action contract the root schema cannot
 * express, exactly as they were in the single verb.
 */
export const GRAPH_READ_ACTIONS = ['view', 'export', 'query', 'summary', 'path'] as const;
export const GRAPH_READ_PARAMETERS: Readonly<Record<typeof GRAPH_READ_ACTIONS[number], readonly string[]>> = {
  view: ['action', 'id', 'cursor', 'limit', 'asOfSequence'],
  export: ['action', 'cursor', 'limit', 'asOfSequence'],
  query: ['action', 'kind', 'keyPrefix', 'labelContains', 'attributeKey', 'attributeValue', 'assertionKind', 'statementContains', 'cursor', 'limit'],
  summary: ['action', 'cursor', 'limit'],
  // R3.2/D-R1-11: a bounded reachability read; fromId is required, every other field narrows it.
  path: ['action', 'fromId', 'toId', 'toKind', 'effect', 'maxDepth', 'maxNodes', 'kinds'],
};
/** Keep a root object: Pi's legacy Anthropic adapter reads only root properties/required.
 * A root anyOf silently loses all tool arguments there. Host enforces action-specific fields/limits.
 */
export const graphReadParameters = object({
  action: choices(GRAPH_READ_ACTIONS), id: Type.Optional(id()),
  cursor: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  asOfSequence: Type.Optional(Type.Integer({ minimum: 0 })),
  /** R1.3: bounded current-head query filters; each is one indexed/LIKE predicate over the asset or assertion head. */
  kind: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: 'Asset kind (keyPrefix needs it)' })),
  keyPrefix: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Asset key prefix; needs kind' })),
  labelContains: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Asset label substring' })),
  attributeKey: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: 'Asset attribute name (with attributeValue)' })),
  attributeValue: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: 'Exact attribute value' })),
  assertionKind: Type.Optional(Type.String({ minLength: 1, maxLength: 40, description: 'fact:<observed|inferred|contract|configuration> or hypothesis' })),
  statementContains: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Assertion statement substring' })),
  /** R3.2: `path` walks current relation heads from one asset; the rest of the fields narrow the walk. */
  fromId: Type.Optional(Type.String({ minLength: 1, maxLength: 80, pattern: '^asset-[a-f0-9]{24}$', description: 'Path start asset entity ID' })),
  toId: Type.Optional(Type.String({ minLength: 1, maxLength: 80, pattern: '^asset-[a-f0-9]{24}$', description: 'Optional target asset ID' })),
  toKind: Type.Optional(Type.String({ minLength: 1, maxLength: 40, description: 'Optional target asset kind' })),
  effect: Type.Optional(Type.String({ minLength: 1, maxLength: 40, description: 'Optional typed capability the path should reach (e.g. data.read, db.query, host.shell)' })),
  maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 })), maxNodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  kinds: Type.Optional(Type.Array(choices(RELATION_KINDS), { minItems: 1, maxItems: 16, description: 'Only walk these relation kinds' })),
}, { additionalProperties: false });

/** The write half of the old verb: one batch, no action field because the verb is the action. */
export const graphRecordParameters = object({
  batch,
  requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$' })),
}, { additionalProperties: false });

/**
 * Owner review names the retained row instead of re-typing it: the host reads the current assertion or relation and derives
 * the identity the supersede needs (statement, subject, kind, endpoints), so a settle cannot silently rewrite what it judges.
 */
export const REVIEW_OUTCOMES = ['supported', 'refuted', 'inconclusive', 'observed'] as const;
export const graphReviewParameters = object({
  id: Type.String({ minLength: 1, maxLength: 160 }),
  outcome: choices(REVIEW_OUTCOMES),
  evidenceRefs: refs(), counterevidenceRefs: refs(),
  requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$' })),
}, { additionalProperties: false });

/** Planner-only coordination: the chain join (plus its plan write) and the manual artifact-ingest retry. */
export const GRAPH_PLAN_ACTIONS = ['chain', 'ingest'] as const;
export const GRAPH_PLAN_PARAMETERS: Readonly<Record<typeof GRAPH_PLAN_ACTIONS[number], readonly string[]>> = {
  chain: ['action', 'limit', 'plan', 'assetRefs', 'requestId'],
  // R2.3: `id` is the retained artifact ID; reusing the root id keeps the declaration budget flat (no second identifier field).
  ingest: ['action', 'id'],
};
export const graphPlanParameters = object({
  action: choices(GRAPH_PLAN_ACTIONS), id: Type.Optional(id()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  /** P14.10: `chain` can also hand back the next task draft and record the chain as todos; it never dispatches. */
  plan: Type.Optional(Type.Boolean()),
  requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$' })),
  assetRefs: Type.Optional(Type.Array(Type.Object({ id: Type.String({ pattern: '^asset-[a-f0-9]{24}$' }), revision: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }), { minItems: 1, description: 'Assets the drafted task stands on; copied from the graph, never inferred from a surface string' })),
}, { additionalProperties: false });

/** Fields an asset may carry on its row instead of inside the nested `asset` object. */
const ASSET_ROW_FIELDS = ['kind','key','label','attributes','anchors','evidenceRefs','expectedRevision'] as const;
const BATCH_FIELDS = ['assets','facts','hypotheses','relations','anchors'] as const;
const REQUEST_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** `supersedes:""` means "no predecessor"; drop it so the canonical batch hashes the same either way. */
function dropEmptyIds(row: unknown): unknown {
  if (!isRecord(row)) return row;
  const copy = { ...row };
  if (copy.supersedes === '') delete copy.supersedes;
  if (isRecord(copy.anchor)) copy.anchor = dropEmptyIds(copy.anchor);
  if (Array.isArray(copy.anchors)) copy.anchors = copy.anchors.map(dropEmptyIds);
  return copy;
}

/** Fold one row-level asset drift into `{asset, ref}`; a genuinely ambiguous row is refused naming the accepted shapes. */
function normalizeAssetRow(raw: unknown, index: number): { asset: AssetInput; ref?: string } {
  const label = `Graph batch assets[${index}]`;
  if (!isRecord(raw)) throw Error(`${label} must be an object: {asset:{kind,key,...}, ref?} or a flat {kind,key,...}. Received ${Array.isArray(raw) ? 'an array' : typeof raw}`);
  const row = { ...raw }, ref = row.ref;
  delete row.ref;
  const nested = row.asset;
  delete row.asset;
  const hoisted: Record<string, unknown> = {};
  for (const field of ASSET_ROW_FIELDS) if (row[field] !== undefined) { hoisted[field] = row[field]; delete row[field]; }
  const stray = Object.keys(row);
  if (stray.length) throw Error(`${label} has unknown field(s): ${stray.join(', ')}; a row holds {asset, ref} and may carry asset fields (${ASSET_ROW_FIELDS.join(', ')}) directly. Put free-form metadata under asset.attributes`);
  const asset: Record<string, unknown> | undefined = nested === undefined ? undefined : isRecord(nested) ? { ...nested } : undefined;
  if (nested !== undefined && asset === undefined) throw Error(`${label}.asset must be an object with kind and key`);
  if (asset === undefined) {
    if (hoisted.kind === undefined || hoisted.key === undefined) throw Error(`${label} has no asset object and no flat kind/key; send {asset:{kind,key,...}, ref?} or put kind and key on the row`);
    return { asset: hoisted as unknown as AssetInput, ...(ref === undefined ? {} : { ref: ref as string }) };
  }
  for (const [field, value] of Object.entries(hoisted)) {
    const existing = asset[field];
    if (existing === undefined) { asset[field] = value; continue; }
    if (field === 'evidenceRefs' && Array.isArray(existing) && Array.isArray(value)) { asset[field] = [...new Set([...(existing as string[]), ...(value as string[])])]; continue; }
    if (graphCanonical(existing) !== graphCanonical(value)) throw Error(`${label} sets ${field} both inside asset and on the row with different values; keep one`);
  }
  return { asset: asset as unknown as AssetInput, ...(ref === undefined ? {} : { ref: ref as string }) };
}

function requestIdOf(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw Error(`${where} must be 1..80 characters matching ${REQUEST_ID.source}`);
  return value;
}

/**
 * A1: accept what models actually emit for `record` and fold it into one canonical batch. The host validates the result
 * (`validateGraphBatch` + `graphObject`); this function only removes placement noise, never a producer-owned field:
 * - `requestId` inside the batch is hoisted (Stripe-style idempotency keys belong on the envelope, so a model that treats the
 *   batch as the envelope is corrected, not punished); two conflicting keys are refused.
 * - a row-level `evidenceRefs`/`expectedRevision`/`anchors`/`label`/`attributes` is folded into `asset`, and a flat row
 *   (kind/key on the row, no nested asset) becomes an asset.
 * - `supersedes:""` is dropped because it means "none" to the model.
 */
export function normalizeGraphRecord(batchInput: unknown, requestIdInput: unknown): { batch: GraphBatch; requestId?: string } {
  if (!isRecord(batchInput)) throw Error(`record needs batch as an object holding assets/facts/hypotheses/relations/anchors; received ${typeof batchInput}`);
  const source = { ...batchInput };
  const fromBatch = requestIdOf(source.requestId, 'requestId inside batch');
  delete source.requestId;
  const fromParams = requestIdOf(requestIdInput, 'requestId');
  if (fromBatch !== undefined && fromParams !== undefined && fromBatch !== fromParams) throw Error(`record got two different requestId values ("${fromParams}" at the top level and "${fromBatch}" inside batch); pass one`);
  const stray = Object.keys(source).filter(key => !(BATCH_FIELDS as readonly string[]).includes(key));
  if (stray.length) throw Error(`Graph batch has unknown field(s): ${stray.join(', ')}; batch holds only ${BATCH_FIELDS.join(', ')}, and each asset row goes under batch.assets`);
  if (Array.isArray(source.assets)) source.assets = source.assets.map(normalizeAssetRow);
  for (const list of ['facts','hypotheses','relations','anchors'] as const) if (Array.isArray(source[list])) source[list] = (source[list] as unknown[]).map(dropEmptyIds);
  for (const row of (Array.isArray(source.assets) ? source.assets : []) as Array<{ asset?: unknown }>) if (isRecord(row.asset) && Array.isArray(row.asset.anchors)) row.asset.anchors = (row.asset.anchors as unknown[]).map(dropEmptyIds);
  const requestId = fromParams ?? fromBatch;
  return { batch: source as unknown as GraphBatch, ...(requestId === undefined ? {} : { requestId }) };
}
