import { createHash } from 'node:crypto';
import { redact } from '../evidence.js';
import { redactArtifactPrefix } from '../artifacts.js';

/** Knowledge identities, never scope authorization. Exact bytes; no URL/path/method aliasing. */
export const GRAPH_IDENTITY_VERSION = 1;
export const ASSET_KINDS = ['endpoint','route','file','symbol','binary','package','identity','config','data','host','service','other'] as const;
export const FACT_KINDS = ['observed','inferred','contract','configuration'] as const;
export const HYPOTHESIS_STATUS = ['open','supported','refuted','inconclusive'] as const;
export const RELATION_KINDS = ['contains','resolves_to','exposes','implemented_by','consumes','authenticates_as','alias_of','depends_on','authenticates','reads','writes','owns','hosts','variant_of','anchors','derived_from'] as const;
export const ANCHOR_KINDS = ['path','symbol','url','header','config','commit','artifact'] as const;
export const CONFIDENCE = ['low','medium','high'] as const;
export const GRAPH_ENTITY_LIMIT = 5000; // retained asset revisions, not lifetime/work permission
export const GRAPH_ASSERTION_LIMIT = 10000;
export const GRAPH_ANCHOR_LIMIT = 10; // nested anchors per submitted asset
export const GRAPH_ANCHOR_ROWS = 20000;
export const GRAPH_RELATION_LIMIT = 2000;
export const GRAPH_PROVENANCE_LIMIT = 40000;
export const GRAPH_BATCH_ROWS = 128; // includes nested anchors and their ACKs
export const GRAPH_ROW_BYTES = 8 * 1024;
export const GRAPH_RESPONSE_BYTES = 24 * 1024;

export interface AnchorInput { kind: typeof ANCHOR_KINDS[number]; value: string; locator?: Record<string, string>; artifactId?: string; supersedes?: string }
export interface AssetInput { kind: typeof ASSET_KINDS[number]; key: string; label?: string; attributes?: Record<string, string>; anchors?: AnchorInput[]; evidenceRefs?: string[]; expectedRevision?: number }
export interface FactInput { assetId: string; assetRevision?: number; kind: typeof FACT_KINDS[number]; statement: string; confidence: typeof CONFIDENCE[number]; evidenceRefs?: string[]; supersedes?: string }
export interface HypothesisInput { assetId: string; assetRevision?: number; statement: string; status: typeof HYPOTHESIS_STATUS[number]; impact?: string; evidenceRefs?: string[]; counterevidenceRefs?: string[]; supersedes?: string }
export interface RelationInput { kind: typeof RELATION_KINDS[number]; fromId: string; toId: string; fromRevision?: number; toRevision?: number; note?: string; evidenceRefs?: string[]; basis?: 'observed' | 'inferred'; status?: 'active' | 'withdrawn'; supersedes?: string }
export interface GraphBatch { assets?: Array<{asset: AssetInput; ref?: string}>; facts?: FactInput[]; hypotheses?: HypothesisInput[]; relations?: RelationInput[]; anchors?: Array<{assetId: string; assetRevision?: number; anchor: AnchorInput}> }
/** Supplied only by the host's current assignment registry, not a model batch. */
export interface GraphProducer { actorId: string; taskId?: string; role?: string; depth?: number }
export interface GraphAck { kind: string; entityId: string; id: string; revision: number; sequence: number; created: boolean; observationSequence: number; storeVersion: number }
export type GraphTable = 'assets' | 'assertions' | 'relations' | 'anchors';
export type GraphRow = Record<string, unknown> & { id: string; entityId: string; revision: number; sequence: number };
export interface GraphObservation { id: string; entityId: string; revisionId: string; actorId: string; taskId?: string; role?: string; depth?: number; at: string; sequence: number }
export interface GraphSnapshot { identityVersion: number; runId:string; scope: string; asOfSequence: number; assets: GraphRow[]; assertions: GraphRow[]; relations: GraphRow[]; anchors: GraphRow[]; provenance: GraphObservation[] }
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export const scopeOf = (targetIdentity: string) => sha(targetIdentity).slice(0, 32);
export const assetEntityId = (scope: string, kind: string, key: string) => `asset-${sha(`${scope}\u0000${kind}\u0000${key}`).slice(0,24)}`;
export const assertionEntityId = (subjectEntity: string, kind: string, statement: string) => `assertion-${sha(`${subjectEntity}\u0000${kind}\u0000${statement}`).slice(0,24)}`;
export const relationEntityId = (scope: string, kind: string, from: string, to: string) => `relation-${sha(`${scope}\u0000${kind}\u0000${from}\u0000${to}`).slice(0,24)}`;
export const anchorEntityId = (assetEntity: string, kind: string, value: string) => `anchor-${sha(`${assetEntity}\u0000${kind}\u0000${value}`).slice(0,24)}`;
/** Canonical content hashing is independent of property insertion order and locale. */
export function graphCanonical(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,x]) => [k, normalize(x)])) : v;
  return JSON.stringify(normalize(value));
}
export function graphObject(value: unknown, fields: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !fields.includes(key))) throw Error(`${label} has an invalid shape or unknown fields; producer/scope/authority are host-owned`);
}
function text(value: unknown, max: number, label: string, options: {key?: boolean} = {}): string {
  if (typeof value !== 'string' || !value || value.length > max || Buffer.byteLength(value) > max || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)
    || value !== value.normalize('NFC')) throw Error(`${label} must be 1..${max} NFC text without control characters`);
  if (options.key && value.trim() !== value) throw Error(`${label} must not start or end with whitespace; identity uses exact bytes`);
  return value;
}
const oneOf = <T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] => {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw Error(`${label} must be one of ${allowed.join(', ')}`);
  return value as T[number];
};
const secretName = (value: string) => /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|token|private[-_]?key|environment|tickets?|socket)$/i.test(value);
/** Detection is best effort. Identifying text is refused, not redacted into a colliding public hash. */
function identityText(value: unknown, max: number, label: string): string {
  const exact = text(value, max, label, {key:true});
  let sensitiveQuery = false;
  for (const part of exact.matchAll(/[?&;]([^?&;=\s]+)=([^&;\s]*)/g)) {
    let name = part[1]; try { name = decodeURIComponent(name.replace(/\+/g,' ')); } catch { /* Never normalize the identity itself. */ }
    if (secretName(name) && part[2] && part[2] !== '[REDACTED]') sensitiveQuery = true;
  }
  if (redactArtifactPrefix(exact,redact) !== exact || /[a-z][a-z0-9+.-]*:\/\/[^/\s?#]*@/i.test(exact) || sensitiveQuery)
    throw Error(`${label} contains secret-bearing identity text; use a non-secret operator label or opaque handle`);
  return exact;
}
const safeText = (value: unknown, max: number, label: string) => redactArtifactPrefix(text(value,max,label),redact);
function dictionary(value: unknown, count: number, label: string): Record<string,string> | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Object.keys(value).length > count)
    throw Error(`${label} must be a dictionary with at most ${count} entries`);
  return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([name,v])=>{
    text(name,64,`${label} name`);
    if (['__proto__','prototype','constructor'].includes(name)) throw Error(`${label} has an unsafe property name`);
    const content=text(v,500,`${label} ${name}`);
    return [name,secretName(name)?'[REDACTED]':redactArtifactPrefix(content,redact)];
  }));
}
const refs = (value: unknown, label: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10 || value.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(id))) throw Error(`${label} must be at most 10 record IDs`);
  return [...new Set(value as string[])].sort();
};
function revision(value: unknown, label: string): number | undefined {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw Error(`${label} must be a positive integer`);
  return value as number;
}
function supersedes(value: unknown, prefix: string): string | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || !new RegExp(`^${prefix}-[a-f0-9]{24}-r[1-9][0-9]{0,8}$`).test(value)) throw Error('supersedes must name a retained graph revision');
  return value;
}
export function validateAsset(input: AssetInput) {
  graphObject(input,['kind','key','label','attributes','anchors','evidenceRefs','expectedRevision'],'Asset input');
  if (input.anchors !== undefined && (!Array.isArray(input.anchors) || input.anchors.length > GRAPH_ANCHOR_LIMIT)) throw Error(`Asset anchors are limited to ${GRAPH_ANCHOR_LIMIT}`);
  return {kind:oneOf(input.kind,ASSET_KINDS,'Asset kind'),key:identityText(input.key,500,'Asset key'),expectedRevision:revision(input.expectedRevision,'Expected asset revision'),evidenceRefs:refs(input.evidenceRefs,'Asset evidence'),
    body:{label:input.label===undefined?null:safeText(input.label,200,'Asset label'),attributes:dictionary(input.attributes,16,'Asset attributes')??null,
      anchors:(input.anchors??[]).map(validateAnchor).sort((a,b)=>graphCanonical(a)<graphCanonical(b)?-1:1)}};
}
export function validateAnchor(input: AnchorInput) {
  graphObject(input,['kind','value','locator','artifactId','supersedes'],'Anchor input');
  const artifactId=input.artifactId===undefined?undefined:text(input.artifactId,80,'Anchor artifact ID',{key:true});
  if (artifactId && !/^artifact-[a-f0-9-]{36}$/.test(artifactId)) throw Error('Anchor artifact ID must be an opaque owner artifact ID');
  return {kind:oneOf(input.kind,ANCHOR_KINDS,'Anchor kind'),value:identityText(input.value,1000,'Anchor value'),locator:dictionary(input.locator,8,'Anchor locator')??null,artifactId:artifactId??null,supersedes:supersedes(input.supersedes,'anchor')};
}
export function validateFact(input: FactInput) {
  graphObject(input,['assetId','assetRevision','kind','statement','confidence','evidenceRefs','supersedes'],'Fact input');
  return {kind:oneOf(input.kind,FACT_KINDS,'Fact kind'),statement:identityText(input.statement,2000,'Fact statement'),confidence:oneOf(input.confidence,CONFIDENCE,'Fact confidence'),
    evidenceRefs:refs(input.evidenceRefs,'Fact evidence'),assetRevision:revision(input.assetRevision,'Fact asset revision'),supersedes:supersedes(input.supersedes,'assertion')};
}
export function validateHypothesis(input: HypothesisInput) {
  graphObject(input,['assetId','assetRevision','statement','status','impact','evidenceRefs','counterevidenceRefs','supersedes'],'Hypothesis input');
  return {statement:identityText(input.statement,2000,'Hypothesis statement'),status:oneOf(input.status,HYPOTHESIS_STATUS,'Hypothesis status'),impact:input.impact===undefined?null:safeText(input.impact,1000,'Hypothesis impact'),
    evidenceRefs:refs(input.evidenceRefs,'Hypothesis evidence'),counterevidenceRefs:refs(input.counterevidenceRefs,'Hypothesis counterevidence'),assetRevision:revision(input.assetRevision,'Hypothesis asset revision'),supersedes:supersedes(input.supersedes,'assertion')};
}
export function validateRelation(input: RelationInput) {
  graphObject(input,['kind','fromId','toId','fromRevision','toRevision','note','evidenceRefs','basis','status','supersedes'],'Relation input');
  return {kind:oneOf(input.kind,RELATION_KINDS,'Relation kind'),note:input.note===undefined?null:safeText(input.note,1000,'Relation note'),evidenceRefs:refs(input.evidenceRefs,'Relation evidence'),
    basis:input.basis===undefined?'inferred' as const:oneOf(input.basis,['observed','inferred'] as const,'Relation basis'),status:input.status===undefined?'active' as const:oneOf(input.status,['active','withdrawn'] as const,'Relation status'),
    fromRevision:revision(input.fromRevision,'Relation from revision'),toRevision:revision(input.toRevision,'Relation to revision'),supersedes:supersedes(input.supersedes,'relation')};
}
export function validateGraphBatch(value: unknown): asserts value is GraphBatch {
  graphObject(value,['assets','facts','hypotheses','relations','anchors'],'Graph batch');
  let total=0;
  for (const key of ['assets','facts','hypotheses','relations','anchors'] as const) {
    const rows=value[key];if(rows===undefined)continue;
    if(!Array.isArray(rows)||rows.length>GRAPH_BATCH_ROWS)throw Error('Graph batch lists must contain 1..128 rows');total+=rows.length;
  }
  for (const row of (value.assets??[]) as Array<{asset:AssetInput;ref?:string}>) {
    graphObject(row,['asset','ref'],'Graph asset row');validateAsset(row.asset);total+=row.asset.anchors?.length??0;
    if(row.ref!==undefined&&(typeof row.ref!=='string'||! /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(row.ref)))throw Error('Batch ref must be a unique 1..32 character label');
  }
  if(!total)throw Error('Graph batch must contain at least one row');
  if(total>GRAPH_BATCH_ROWS)throw Error('Graph batch must contain 1..128 rows including nested anchors');
  if(Buffer.byteLength(graphCanonical(value))>128*1024)throw Error('Graph mutation payload exceeds 128 KiB');
}
export const graphEntityId = (value: unknown, prefix: string): string => {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}-[a-f0-9]{24}$`).test(value)) throw Error(`Unknown ${prefix} identity`);
  return value;
};
/** Escape Mermaid label metacharacters, HTML, links and directives as numeric entity text. */
export function renderGraph(input: {scope:string;assets:GraphRow[];assertions:GraphRow[];relations:GraphRow[]}) {
  const json={scope:input.scope,identityVersion:GRAPH_IDENTITY_VERSION,assets:input.assets,assertions:input.assertions,relations:input.relations,
    warning:'Attributed graph claims, not verified findings or permission. Stale pins require revalidation.'};
  const label=(value:unknown)=>Array.from(String(value).slice(0,80)).map(char=>/[a-zA-Z0-9 ._:/-]/.test(char)?char:`#${char.codePointAt(0)};`).join('');
  const node=(id:string)=>`n${id.replace(/[^a-zA-Z0-9]/g,'')}`; // use the complete identity, not an 8-hex collision domain
  const ids=new Set(input.assets.map(a=>a.entityId)),lines=['```mermaid','graph LR'];
  for(const asset of input.assets)lines.push(`  ${node(asset.entityId)}["${label(`${asset.kind}: ${asset.key}`)}"]`);
  for(const assertion of input.assertions)if(ids.has(String(assertion.subjectId))) {
    lines.push(`  ${node(assertion.entityId)}(["${label(assertion.statement)}"])`);
    lines.push(`  ${node(String(assertion.subjectId))} -.->|"${label(assertion.kind)}${assertion.stale?' STALE':''}"| ${node(assertion.entityId)}`);
  }
  for(const relation of input.relations)if(ids.has(String(relation.fromId))&&ids.has(String(relation.toId)))
    lines.push(`  ${node(String(relation.fromId))} -- "${label(relation.kind)}${relation.stale?' STALE':''}${relation.status==='withdrawn'?' WITHDRAWN':''}" --> ${node(String(relation.toId))}`);
  lines.push('```');return {json,mermaid:lines.join('\n')};
}
/** Read-only replay of committed graph deltas. Never calls a store, broker, worker or target. */
export function applyGraphEvents(snapshot: GraphSnapshot, events: Array<{sequence:number;runId:string;data?:Record<string,unknown>}>) : GraphSnapshot {
  const result=structuredClone(snapshot), tables=['assets','assertions','relations','anchors','provenance'] as const;
  for(const event of [...events].sort((a,b)=>a.sequence-b.sequence)) {
    if(event.sequence<=snapshot.asOfSequence)continue;
    const delta=event.data?.graph as {scope?:string;table?:typeof tables[number];body?:GraphRow;observation?:GraphObservation}|undefined;
    if(!delta)continue;
    if(event.runId!==snapshot.runId||delta.scope!==snapshot.scope||!tables.includes(delta.table!))throw Error('Foreign or unknown graph event; read-only rebuild refused');
    if(delta.body){const table=result[delta.table!] as Array<GraphRow|GraphObservation>,row={...delta.body,sequence:event.sequence};if(!table.some(r=>r.id===row.id))table.push(row);}
    if(delta.observation){const row={...delta.observation,sequence:event.sequence};if(!result.provenance.some(r=>r.id===row.id))result.provenance.push(row);}
  }
  for(const event of events)result.asOfSequence=Math.max(result.asOfSequence,event.sequence);return result;
}
