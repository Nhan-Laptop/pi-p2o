import { Type } from 'typebox';
import { choices } from '../schema-kit.js';
import { ASSET_KINDS, ANCHOR_KINDS, CONFIDENCE, FACT_KINDS, HYPOTHESIS_STATUS, RELATION_KINDS, graphCanonical, type AssetInput, type GraphBatch } from './graph.js';

const id = () => Type.String({ minLength: 1, maxLength: 80 });
const refs = () => Type.Optional(Type.Array(id()));
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
 * that are allowed instead of losing the whole call to Pi's argument validator. The root stays strict (action/batch/requestId).
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
export const GRAPH_ACTIONS = ['record','view','page','export','chain'] as const;
/** P13e: exhaustive per action; `page` and `export` share a shape but are named separately. */
export const GRAPH_ACTION_PARAMETERS: Readonly<Record<typeof GRAPH_ACTIONS[number], readonly string[]>> = {
  record: ['action','batch','requestId'], view: ['action','id','cursor','limit','asOfSequence'], chain: ['action','limit','plan','assetRefs','requestId'],
  page: ['action','cursor','limit','asOfSequence'], export: ['action','cursor','limit','asOfSequence'],
};
/** Keep a root object: Pi's legacy Anthropic adapter reads only root properties/required.
 * A root anyOf silently loses all tool arguments there. Host enforces action-specific fields/limits.
 */
export const graphParameters = object({
  action: choices(GRAPH_ACTIONS), batch: Type.Optional(batch), id: Type.Optional(id()),
  requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$' })),
  cursor: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  asOfSequence: Type.Optional(Type.Integer({ minimum: 0 })),
  /** P14.10: `chain` can also hand back the next task draft and record the chain as todos; it never dispatches. */
  plan: Type.Optional(Type.Boolean()),
  assetRefs: Type.Optional(Type.Array(Type.Object({ id: Type.String({ pattern: '^asset-[a-f0-9]{24}$' }), revision: Type.Optional(Type.Integer({ minimum: 1 })), variant: Type.Optional(Type.String({ maxLength: 120 })) }, { additionalProperties: false }), { minItems: 1, description: 'Assets the drafted task stands on; copied from the graph, never inferred from a surface string' })),
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
