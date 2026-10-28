/**
 * R2.3: write an extraction result as attributed graph rows.
 *
 * The extractor is host code, so it writes through a host producer (`extractor`, depth 0): every row is attributable, unverified
 * knowledge, and the receipt that produced the artifact stays the evidence. Nothing here creates a claim, a case, a coverage
 * cell or a finding — the extractor has no path to those tables by construction, and the caller only gets write counts back.
 *
 * Both the executor-side role whitelist and the graph row cap are enforced by the store, so this module only decides the
 * batching: one batch never exceeds the row/byte bound, and facts/hypotheses are written in a second pass once asset entity ids
 * exist (a batch-local `@ref` cannot cross a batch boundary).
 */
import { assetEntityId } from './state/graph.js';
import type { ArtifactManifest, AssessmentStore, MutationRequest } from './state/store.js';
import type { AssetInput, FactInput, GraphAck, GraphBatch, GraphProducer, HypothesisInput } from './state/graph.js';
import { EXTRACT_MAX_ROW_BYTES, type ExtractResult } from './extract/index.js';

/** Store-side row ceiling is 128 rows including anchors; stay below it so a full chunk always fits. */
const ROWS_PER_BATCH = 100;
const BYTES_PER_BATCH = 96 * 1024;
const AUTO_PRODUCER: GraphProducer = { actorId: 'extractor', role: 'extractor', depth: 0 };

export interface IngestWriteCounts { assets: number; facts: number; hypotheses: number; components: number; batches: number }
export interface IngestOutcome extends IngestWriteCounts {
  extractor: string;
  evidenceRefs: string[];
  warnings: string[];
  omitted: ExtractResult['omitted'];
  /** Set when a chunk was refused (capacity/validation): earlier chunks are committed and the counts describe them. */
  error?: string;
}

const canonical = (asset: AssetInput) => {
  const attributes = asset.attributes ?? {};
  const ecosystem = attributes.ecosystem, name = attributes.name, version = attributes.version;
  if (!ecosystem || !name || !version) return asset;
  return { ...asset, key: `${ecosystem}:${name}@${version}`, attributes: { ...attributes } };
};

/** Split rows so one batch never breaks the store's row cap or the 128 KiB mutation payload bound. */
export function batchRows<T>(rows: readonly T[], bytes: (rows: readonly T[]) => number, rowCap = ROWS_PER_BATCH, byteCap = BYTES_PER_BATCH): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  for (const row of rows) {
    const next = [...current, row];
    if (current.length >= rowCap || bytes(next) > byteCap) {
      if (current.length) batches.push(current);
      current = [row];
    } else current = next;
  }
  if (current.length) batches.push(current);
  return batches;
}

const sizeOf = (rows: readonly unknown[]) => Buffer.byteLength(JSON.stringify(rows));

/**
 * Write one extractor result. The artifact anchor is a separate anchor row on the first asset (never asset content): two captures
 * of the same bytes are the same asset, while their provenance anchors are separate revisions. Facts and hypotheses cite the
 * receipt, so a re-ingest through the same artifact plus receipt adds an observation rather than a revision.
 */
export function ingestExtract(store: AssessmentStore, result: ExtractResult, options: { artifact: ArtifactManifest; evidenceRefs: readonly string[]; requestPrefix?: string; now?: () => string }): IngestOutcome {
  const evidenceRefs = [...new Set(options.evidenceRefs)].slice(0, 10);
  if (!evidenceRefs.length) throw Error('INGEST_WITHOUT_EVIDENCE: extraction rows cite the receipt that produced the artifact; an artifact without a same-run operation receipt cannot be ingested');
  const prefix = (options.requestPrefix ?? `extract-${options.artifact.id}`).replace(/[^a-zA-Z0-9._:-]/g, '-').slice(0, 70);
  let batches = 0;
  const counts: IngestWriteCounts = { assets: 0, facts: 0, hypotheses: 0, components: result.components.length, batches: 0 };
  const write = (batch: GraphBatch, label: string) => {
    const request: MutationRequest = { actorId: AUTO_PRODUCER.actorId, requestId: `${prefix}-${label}`, payload: { ingest: options.artifact.id, label } };
    batches += 1;
    return store.recordGraph(batch, request, AUTO_PRODUCER);
  };
  // Assets first: a fact names an entity id, and ids only exist after the asset row is committed.
  const assets: Array<{ asset: AssetInput; ref: string }> = result.assets.map((asset, index) => ({
    asset: canonical({ kind: asset.kind, key: asset.key, ...(asset.label ? { label: asset.label } : {}), ...(asset.attributes ? { attributes: asset.attributes } : {}),
      ...(asset.anchors ? { anchors: asset.anchors.slice(0, 4) } : {}) }),
    ref: `a${index}`,
  }));
  const ids = new Map<number, string>();
  try {
    for (const [index, chunk] of batchRows(assets, sizeOf).entries()) {
      const acks = write({ assets: chunk }, `assets-${index}`);
      const written = acks.filter(ack => ack.kind === 'asset');
      chunk.forEach((row, position) => { const ack = written[position]; if (ack) ids.set(Number(row.ref.slice(1)), ack.entityId); });
      counts.assets += written.length;
    }
    const facts: FactInput[] = result.facts.flatMap(fact => {
      const assetId = ids.get(fact.asset);
      return assetId ? [{ assetId, kind: fact.kind, statement: fact.statement, confidence: fact.confidence, evidenceRefs }] : [];
    });
    for (const [index, chunk] of batchRows(facts, sizeOf).entries()) {
      const acks = write({ facts: chunk }, `facts-${index}`);
      counts.facts += acks.filter((ack: GraphAck) => ack.kind.startsWith('fact:')).length;
    }
    const hypotheses: HypothesisInput[] = result.hypotheses.flatMap(hypothesis => {
      const assetId = ids.get(hypothesis.asset);
      return assetId ? [{ assetId, statement: hypothesis.statement, status: 'open' as const, ...(hypothesis.impact ? { impact: hypothesis.impact } : {}), evidenceRefs }] : [];
    });
    for (const [index, chunk] of batchRows(hypotheses, sizeOf).entries()) {
      const acks = write({ hypotheses: chunk }, `hypotheses-${index}`);
      counts.hypotheses += acks.filter((ack: GraphAck) => ack.kind === 'hypothesis').length;
    }
    const subject = ids.get(0);
    if (subject) write({ anchors: [{ assetId: subject, anchor: { kind: 'artifact', value: options.artifact.id, artifactId: options.artifact.id,
      locator: { kind: options.artifact.kind, sha256: options.artifact.sha256 } } }] }, 'artifact-anchor');
  } catch (error) {
    counts.batches = batches;
    return { ...counts, extractor: result.extractor, evidenceRefs, warnings: [...result.warnings, 'ingest stopped at a store refusal; the counts above are the rows that were committed'],
      omitted: result.omitted, error: error instanceof Error ? error.message : String(error) };
  }
  counts.batches = batches;
  // Sanity: every extractor row byte bound is also a store row bound; a mismatch here would be a code bug, not input.
  const longest = [...result.facts, ...result.hypotheses].reduce((max, row) => Math.max(max, Buffer.byteLength(JSON.stringify(row))), 0);
  if (longest > EXTRACT_MAX_ROW_BYTES) throw Error('Extractor row exceeds the 7 KiB ingest bound; this is a parser bug');
  return { ...counts, extractor: result.extractor, evidenceRefs, warnings: result.warnings, omitted: result.omitted };
}

/** Entity id an extraction asset would land on, for callers that need to resolve a component asset without writing. */
export const previewEntityId = (scope: string, asset: AssetInput) => assetEntityId(scope, asset.kind, canonical(asset).key);
