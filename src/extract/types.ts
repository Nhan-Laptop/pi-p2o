/**
 * R2/D-R1-5: recognized scanner and source artifacts become attributed graph knowledge without a model turn.
 *
 * An extractor is a pure function over bytes the host already retained: no network, no shell, no eval, no target traffic. What
 * it produces is knowledge of the same grade as a model-recorded row — attributed and unverified — so it can never become a
 * claim, a case, coverage or a report finding. The evidence-ladder boundary is why a scanner's "this looked vulnerable" result
 * arrives as an open hypothesis with the receipt as evidence, and a published CVE arrives as a lead: the scanner observed bytes,
 * it did not demonstrate an effect.
 */
import type { ANCHOR_KINDS, ASSET_KINDS, FACT_KINDS } from '../state/graph.js';

/** Per-ingest bounds. One artifact can describe a lot; the loop needs the shape of it, not a full mirror of the scan. */
export const EXTRACT_MAX_INPUT_BYTES = 4 * 1024 * 1024;
export const EXTRACT_MAX_ASSETS = 200;
export const EXTRACT_MAX_FACTS = 1_000;
export const EXTRACT_MAX_HYPOTHESES = 100;
export const EXTRACT_MAX_COMPONENTS = 200;
/** Graph rows are capped at 8 KiB by the store; keep extractor rows under 7 KiB so provenance and hashing still fit. */
export const EXTRACT_MAX_ROW_BYTES = 7 * 1024;
/** Parsing stays linear on a 4 MiB artifact: scanner output past this many records is counted, not walked. */
export const EXTRACT_MAX_RECORDS = 2_000;
export const EXTRACT_MAX_LINKS = 50;
export const EXTRACT_MAX_FORMS = 50;
export const EXTRACT_MAX_SECURITY_HEADERS = 20;

/** What the caller knows about the artifact beyond its text. `url` is the request that produced an HTTP response capture. */
export interface ExtractSource { text: string; kind?: string; mediaType?: string; url?: string }
export interface ExtractAnchor { kind: (typeof ANCHOR_KINDS)[number]; value: string; locator?: Record<string, string> }
export interface ExtractAsset {
  kind: (typeof ASSET_KINDS)[number];
  key: string;
  label?: string;
  attributes?: Record<string, string>;
  anchors?: ExtractAnchor[];
}
/** A fact about `assets[asset]`; the writer turns the index into a batch ref, so no entity id has to be known yet. */
export interface ExtractFact { asset: number; kind: (typeof FACT_KINDS)[number]; statement: string; confidence: 'low' | 'medium' | 'high' }
/** R2.2: scanner output is a hypothesis, never a claim. The writer records it `open` with the receipt as evidence. */
export interface ExtractHypothesis { asset: number; statement: string; impact?: string }
/** A component of the inventory: the package asset an NVD query is derived from. `asset` indexes `assets`. */
export interface ExtractComponent { asset: number; name: string; version: string; ecosystem: string; cpe?: string }
export interface ExtractOmissions { assets: number; facts: number; hypotheses: number; components: number }
export interface ExtractResult {
  extractor: string;
  assets: ExtractAsset[];
  facts: ExtractFact[];
  hypotheses: ExtractHypothesis[];
  components: ExtractComponent[];
  /** Reader-facing notes: what was ignored, truncated or looked malformed. Never throws for malformed input. */
  warnings: string[];
  omitted: ExtractOmissions;
}
/** `undefined` means "this artifact is not my format"; the registry tries the next parser. */
export type Extractor = (source: ExtractSource) => ExtractResult | undefined;
export type { FACT_KINDS };
