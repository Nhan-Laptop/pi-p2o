import { Type } from 'typebox';
import { choices } from '../schema-kit.js';
import { ASSET_KINDS, ANCHOR_KINDS, CONFIDENCE, FACT_KINDS, HYPOTHESIS_STATUS, RELATION_KINDS } from './graph.js';

const id = () => Type.String({ minLength: 1, maxLength: 80 });
const refs = () => Type.Optional(Type.Array(id(), { maxItems: 10 }));
const revision = () => Type.Optional(Type.Integer({ minimum: 1 }));
const supersedes = () => Type.Optional(id());
const object = Type.Object;
const anchor = object({ kind: choices(ANCHOR_KINDS), value: Type.String({ minLength: 1, maxLength: 1000 }),
  locator: Type.Optional(Type.Record(Type.String({ maxLength: 64 }), Type.String({ maxLength: 500 }), { maxProperties: 8 })),
  artifactId: Type.Optional(id()), supersedes: supersedes() }, { additionalProperties: false });
const batch = object({
  assets: Type.Optional(Type.Array(object({ asset: object({ kind: choices(ASSET_KINDS), key: Type.String({ minLength: 1, maxLength: 500 }),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), expectedRevision: revision(), evidenceRefs: refs(),
    attributes: Type.Optional(Type.Record(Type.String({ maxLength: 64 }), Type.String({ maxLength: 500 }), { maxProperties: 16 })),
    anchors: Type.Optional(Type.Array(anchor, { maxItems: 10 })) }, { additionalProperties: false }),
    ref: Type.Optional(Type.String({ minLength: 1, maxLength: 32, pattern: '^[a-zA-Z][a-zA-Z0-9_-]*$' })) }, { additionalProperties: false }), { maxItems: 128 })),
  facts: Type.Optional(Type.Array(object({ assetId: id(), assetRevision: revision(), kind: choices(FACT_KINDS),
    statement: Type.String({ minLength: 1, maxLength: 2000 }), confidence: choices(CONFIDENCE), evidenceRefs: refs(), supersedes: supersedes() }, { additionalProperties: false }), { maxItems: 128 })),
  hypotheses: Type.Optional(Type.Array(object({ assetId: id(), assetRevision: revision(), statement: Type.String({ minLength: 1, maxLength: 2000 }),
    status: choices(HYPOTHESIS_STATUS), impact: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })), evidenceRefs: refs(), counterevidenceRefs: refs(), supersedes: supersedes() }, { additionalProperties: false }), { maxItems: 128 })),
  relations: Type.Optional(Type.Array(object({ kind: choices(RELATION_KINDS), fromId: id(), toId: id(), fromRevision: revision(), toRevision: revision(),
    note: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })), evidenceRefs: refs(), basis: Type.Optional(choices(['observed','inferred'])),
    status: Type.Optional(choices(['active','withdrawn'])), supersedes: supersedes() }, { additionalProperties: false }), { maxItems: 128 })),
  anchors: Type.Optional(Type.Array(object({ assetId: id(), assetRevision: revision(), anchor }, { additionalProperties: false }), { maxItems: 128 })),
}, { additionalProperties: false });
export const GRAPH_ACTIONS = ['record','view','page','export','chain'] as const;
/** P13e: exhaustive per action; `page` and `export` share a shape but are named separately. */
export const GRAPH_ACTION_PARAMETERS: Readonly<Record<typeof GRAPH_ACTIONS[number], readonly string[]>> = {
  record: ['action','batch','requestId'], view: ['action','id','cursor','limit','asOfSequence'], chain: ['action','limit'],
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
}, { additionalProperties: false });
