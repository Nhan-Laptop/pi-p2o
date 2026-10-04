import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  ID_PATTERN, canonicalJson, digestJson, evidenceSchema, handoffEvidenceIds,
  type AttemptRecord, type Classification, type EvidenceKind, type EvidenceReceipt,
  type HandoffPacket, type ObservedRuntime, type RunManifest, type TaskManifest,
} from '../contracts/index.js';
import type { StoredResult } from '../store/index.js';
import { checkId, checkTime, freeze, requireEvidence, sha256 } from './common.js';
import { isWithin, readBoundedArtifact, relativeArtifactPath } from './filesystem.js';
import { reviewHandoff, type HandoffReview } from './verification.js';
import type { CollectorGrant, EvidenceVault } from './vault.js';

/** Default vault kind/classification for a preserved worker handoff packet (a proposal, not proof). */
export const PACKET_EVIDENCE_KIND: EvidenceKind = 'log';
export const PACKET_EVIDENCE_CLASSIFICATION: Classification = 'hypothesis';

const BRIDGE_MARKER = 'result-collector-v1';
const PACKET_PURPOSE = 'handoff-packet';
const DEFAULT_DOCUMENT_BYTES = 64 * 1024;
const MAX_PUBLICATION_RESULTS = 10_000;

/** The supervisor `RuntimeHandle` subset the collector needs; a real RuntimeHandle satisfies it. */
export interface CollectorRuntimeHandle {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly workspace: string;
  readonly controlDir: string;
}

/** Structurally identical to the orchestrator `ResultCandidate`; no orchestrator import is required. */
export interface CollectedResultCandidate {
  readonly packet: unknown;
  readonly idempotencyKey: string;
}

export interface CollectorAttemptView {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly ownerId: string;
  readonly sequence: number;
  readonly lifecycleState: AttemptRecord['lifecycleState'];
  readonly deadlineAt: string;
  readonly requestedRuntime: AttemptRecord['requestedRuntime'];
  readonly observedRuntime?: AttemptRecord['observedRuntime'];
  /** Durable task workspace (not the worker-claimed handle value). */
  readonly workspace: string;
  readonly controlDir: string;
}

/** Where the worker's proposed packet is staged, relative to one approved vault artifact root. */
export interface PacketArtifactSource {
  /** Vault `artifactRoots` key for the root the packet is read from and preserved under. */
  readonly rootId: string;
  /** Absolute canonical path of the same root, used only for the bounded no-follow pre-read. */
  readonly root: string;
  readonly kind?: EvidenceKind;
  readonly classification?: Classification;
  readonly mediaType?: string;
  readonly maxBytes?: number;
  /** Undefined means the worker published nothing; the supervisor records no candidate. */
  locate(attempt: CollectorAttemptView): string | undefined;
}

export interface PacketPreservation {
  readonly attemptId: string;
  readonly evidenceId: string;
  /** Digest of the vault-preserved (redacted, canonical) bytes. */
  readonly digest: string;
  /** Digest of the worker-authored bytes before redaction; hashes only. */
  readonly originalDigest: string;
  readonly byteLength: number;
  readonly packetId?: string;
  readonly duplicate: boolean;
  readonly admittedAt: string;
}

export interface CollectorBridgeStore {
  getRun(runId: string): RunManifest | undefined;
  getTask(taskId: string): TaskManifest | undefined;
  getAttempt(attemptId: string): AttemptRecord | undefined;
  getEvidence(evidenceId: string): EvidenceReceipt | undefined;
  putEvidence(input: unknown): EvidenceReceipt;
  listResults(runId: string): StoredResult[];
}

export interface ResultCollectorBridgeOptions {
  vault: EvidenceVault;
  store: CollectorBridgeStore;
  packets: PacketArtifactSource;
  /** Owner-supplied per-attempt collector grant; must lie inside the run authorization window. */
  grant(attempt: CollectorAttemptView): CollectorGrant | Promise<CollectorGrant>;
  clock?: () => string;
}

/**
 * The supervisor-side result collector. It is structurally a `ResultCollector`: it never admits
 * results itself, it only preserves packet bytes and imports vault-authenticated receipts so the
 * supervisor's lease-fenced `store.admitResult` evaluates the same bytes this bridge verified.
 */
export interface ResultCollectorBridge {
  readonly kind: 'evidence-result-collector';
  collect(handle: CollectorRuntimeHandle): Promise<CollectedResultCandidate[]>;
  preservation(attemptId: string): PacketPreservation | undefined;
}

/** Conventional `handoff.packet.json` inside the supervisor-derived task workspace. */
export function createWorkspacePacketSource(options: {
  root: string;
  rootId: string;
  fileName?: string;
  kind?: EvidenceKind;
  classification?: Classification;
  mediaType?: string;
  maxBytes?: number;
}): PacketArtifactSource {
  requireEvidence(isAbsolute(options.root) && resolve(options.root) === options.root && options.root !== '/', 'path-denied', 'Packet root must be a private canonical absolute path');
  checkId(options.rootId);
  const fileName = relativeArtifactPath(options.fileName ?? 'handoff.packet.json');
  return Object.freeze({
    rootId: options.rootId,
    root: options.root,
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.classification ? { classification: options.classification } : {}),
    ...(options.mediaType ? { mediaType: options.mediaType } : {}),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    locate(attempt: CollectorAttemptView): string | undefined {
      const candidate = join(attempt.workspace, fileName);
      if (!isWithin(options.root, candidate)) return undefined;
      const path = relative(options.root, candidate);
      if (!path) return undefined;
      try {
        relativeArtifactPath(path);
        if (!existsSync(candidate)) return undefined;
      } catch { return undefined; }
      return path;
    },
  });
}

function parseJson(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false } {
  try { return { ok: true, value: JSON.parse(Buffer.from(bytes).toString('utf8')) }; } catch { return { ok: false }; }
}

function packetIdOf(packet: unknown): string | undefined {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(packet, 'packetId');
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'string' && ID_PATTERN.test(descriptor.value) ? descriptor.value : undefined;
}

export function createResultCollectorBridge(options: ResultCollectorBridgeOptions): ResultCollectorBridge {
  const { vault, store } = options;
  const clock = options.clock ?? (() => new Date().toISOString());
  const preservations = new Map<string, PacketPreservation>();

  function importVaultReceipt(attempt: AttemptRecord, evidenceId: string): void {
    if (!ID_PATTERN.test(evidenceId)) return;
    const receipt = vault.get(evidenceId);
    if (!receipt || receipt.runId !== attempt.runId || !store.getAttempt(receipt.attemptId)) return;
    const existing = store.getEvidence(evidenceId);
    if (existing) {
      requireEvidence(canonicalJson(existing) === canonicalJson(receipt), 'receipt-conflict', 'The store already holds different evidence under this vault receipt identity; reconcile it instead of overwriting');
      return;
    }
    store.putEvidence(receipt);
  }

  async function collect(handle: CollectorRuntimeHandle): Promise<CollectedResultCandidate[]> {
    checkId(handle.runId); checkId(handle.taskId); checkId(handle.attemptId);
    const attempt = store.getAttempt(handle.attemptId);
    if (!attempt) return [];
    requireEvidence(attempt.runId === handle.runId && attempt.taskId === handle.taskId, 'bridge-attempt', 'Collector handle does not match the durable attempt');
    const task = store.getTask(attempt.taskId);
    requireEvidence(task && task.runId === attempt.runId, 'bridge-task', 'Collector bridge requires the durable task of the attempt');
    const view: CollectorAttemptView = freeze({
      runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.attemptId, ownerId: attempt.ownerId,
      sequence: attempt.sequence, lifecycleState: attempt.lifecycleState, deadlineAt: attempt.deadlineAt,
      requestedRuntime: attempt.requestedRuntime, ...(attempt.observedRuntime ? { observedRuntime: attempt.observedRuntime } : {}),
      workspace: task.workspace, controlDir: handle.controlDir,
    });
    const located = options.packets.locate(view);
    if (located === undefined) return [];
    const path = relativeArtifactPath(located);
    const maxBytes = Math.min(options.packets.maxBytes ?? vault.limits.maxArtifactBytes, vault.limits.maxArtifactBytes);
    const raw = readBoundedArtifact(options.packets.root, path, maxBytes);
    requireEvidence(raw.length > 0, 'bridge-packet', 'Worker packet file is empty');
    const now = clock(); checkTime(now);
    const workerDigest = sha256(raw);
    // Content-addressed per attempt: identical bytes on a retry stay distinct and immutable.
    const evidenceId = `pkt-${sha256(`${attempt.attemptId}:${workerDigest}`).slice(0, 32)}`;
    let receipt = vault.get(evidenceId), duplicate = true;
    if (!receipt) {
      const asJson = parseJson(raw);
      const mediaType = options.packets.mediaType ?? (asJson.ok ? 'application/json' : 'text/plain');
      const collector = vault.issueCollector(await options.grant(view));
      const admission = vault.admit(collector, {
        evidenceId, idempotencyKey: evidenceId,
        artifact: { rootId: options.packets.rootId, path, expectedDigest: workerDigest, expectedBytes: raw.length, mediaType },
        operationInputDigest: digestJson({ bridge: BRIDGE_MARKER, attemptId: attempt.attemptId, path }),
        kind: options.packets.kind ?? PACKET_EVIDENCE_KIND,
        classification: options.packets.classification ?? PACKET_EVIDENCE_CLASSIFICATION,
        summary: `Preserved worker handoff packet candidate for ${attempt.taskId}/${attempt.attemptId}`,
        collectedAt: now,
        method: 'supervisor result-collector bridge bounded packet preservation',
        toolOptions: [],
        originalEnvironment: true,
        modifications: [],
        metadata: { purpose: PACKET_PURPOSE, bridge: BRIDGE_MARKER, runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.attemptId, sourcePath: path },
      });
      receipt = admission.receipt; duplicate = admission.duplicate;
    }
    const record = vault.inspect(evidenceId);
    requireEvidence(record, 'bridge-preservation', 'Preserved packet record is missing after admission');
    const preserved = vault.read(evidenceId);
    const asJson = parseJson(preserved);
    const packet: unknown = asJson.ok ? asJson.value : Buffer.from(preserved).toString('utf8');
    const packetId = packetIdOf(packet);
    preservations.set(attempt.attemptId, freeze({
      attemptId: attempt.attemptId, evidenceId, digest: receipt.digest, originalDigest: record.originalDigest,
      byteLength: receipt.byteLength, ...(packetId ? { packetId } : {}), duplicate, admittedAt: record.admittedAt,
    }));
    // The preserved packet receipt is durable evidence in its own right: import it into the store index so
    // the controller's own artifact, the publication path and the interface evidence page agree on one set.
    importVaultReceipt(attempt, evidenceId);
    if (packet && typeof packet === 'object' && !Array.isArray(packet)) {
      for (const id of handoffEvidenceIds(packet as HandoffPacket)) importVaultReceipt(attempt, id);
    }
    return [freeze({ packet, idempotencyKey: evidenceId })];
  }

  return Object.freeze({
    kind: 'evidence-result-collector' as const,
    collect,
    preservation(attemptId: string): PacketPreservation | undefined { return preservations.get(attemptId); },
  });
}

/** Supervisor controller runtime receipts are stored under the controller root; never worker JSON. */
export interface ControllerReceiptPolicy {
  /** The supervisor/controller collector identity recorded on its own observation receipts. */
  readonly collectorId: string;
  /** The controller observation tool name; `p2o-supervisor` for the shipped orchestrator. */
  readonly toolName: string;
  /** Canonical controller root holding `receipts/<evidenceId>.json`; required to verify bytes. */
  readonly locatorRoot?: string;
  readonly maxDocumentBytes?: number;
}

export interface ControllerAttestationPolicy extends ControllerReceiptPolicy {
  readonly locatorRoot: string;
}

function documentIssues(receipt: EvidenceReceipt, attempt: AttemptRecord, policy: ControllerAttestationPolicy): string[] {
  const absolute = resolve(receipt.locator);
  if (!isWithin(policy.locatorRoot, absolute)) return ['controller-locator'];
  const path = relative(policy.locatorRoot, absolute);
  if (!path) return ['controller-locator'];
  let bytes: Buffer;
  try { bytes = readBoundedArtifact(policy.locatorRoot, path, policy.maxDocumentBytes ?? DEFAULT_DOCUMENT_BYTES); }
  catch { return ['controller-document']; }
  if (bytes.length !== receipt.byteLength || sha256(bytes) !== receipt.digest) return ['controller-digest'];
  const parsed = parseJson(bytes);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return ['controller-document'];
  const document = parsed.value as Record<string, unknown>;
  if (document.version !== 1 || document.kind !== 'p2o-controller-runtime-observation') return ['controller-document'];
  if (document.controllerId !== receipt.provenance.collectorId || document.runId !== receipt.runId || document.taskId !== receipt.taskId || document.attemptId !== receipt.attemptId) return ['controller-document'];
  if (document.observedAt !== receipt.provenance.collectedAt) return ['controller-document'];
  if (document.observation !== receipt.metadata?.observation || !['live', 'terminated', 'not-started'].includes(String(document.observation))) return ['controller-document'];
  try {
    if (canonicalJson(document.requested) !== canonicalJson(attempt.requestedRuntime.selection)) return ['controller-request'];
  } catch { return ['controller-document']; }
  return [];
}

/**
 * Independent controller attestation of one supervisor-minted runtime receipt. Empty result means
 * the receipt is the controller's own bounded observation document for this attempt. A `worker`
 * trust receipt, an unlisted receipt or a tampered/absent document is never promoted.
 *
 * `attested` defaults to the attempt's *current* observation, the correct fence for live admission.
 * Publishing or reporting an already-admitted packet instead passes the observation that packet was
 * admitted with: the supervisor keeps re-observing a live attempt, so its latest observation is not
 * the only legitimate one for its own earlier, controller-attested receipts.
 */
export function authenticateControllerReceipt(receipt: EvidenceReceipt, attempt: AttemptRecord, policy: ControllerAttestationPolicy, attested: readonly string[] = attempt.observedRuntime?.receiptEvidenceIds ?? []): string[] {
  const issues: string[] = [];
  const parsed = evidenceSchema.safeParse(receipt);
  if (!parsed.success) return ['controller-schema'];
  const e = parsed.data;
  if (e.provenance.trust !== 'collector' || e.kind !== 'runtime') issues.push('controller-trust');
  if (e.runId !== attempt.runId || e.taskId !== attempt.taskId || e.attemptId !== attempt.attemptId) issues.push('controller-attempt');
  if (e.provenance.collectorId !== policy.collectorId || e.provenance.tool.name !== policy.toolName) issues.push('controller-identity');
  if (!attested.includes(e.evidenceId)) issues.push('controller-attestation');
  if (checkTime(e.provenance.collectedAt) < checkTime(attempt.createdAt)) issues.push('controller-window');
  return [...issues, ...documentIssues(e, attempt, policy)];
}

/**
 * Mirrors the supervisor's `attestCandidate`: the controller-observed runtime replaces whatever the
 * worker claimed, and nothing else in the packet changes. Digest agreement with the admitted store
 * result proves the preserved packet is that same content.
 */
export function normalizeAttestedPacket(packet: unknown, observedRuntime: ObservedRuntime | undefined): unknown {
  if (!observedRuntime) return packet;
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return packet;
  try { return { ...(packet as Record<string, unknown>), observedRuntime: JSON.parse(canonicalJson(observedRuntime)) as ObservedRuntime }; }
  catch { return packet; }
}

/**
 * The attempt context an already-admitted result is re-published against.
 *
 * `attestCandidate` pins the controller's own observation into the packet at admission, while the supervisor
 * keeps re-observing a live attempt: every later observation mints a new receipt id and replaces
 * `attempt.observedRuntime`. An admitted packet therefore legitimately carries the observation of its own
 * admission, not the attempt's latest one, and re-reviewing it against the latest state would contradict a
 * decision the controller already made.
 *
 * The pinned observation is used only when every receipt it names is still a durable, controller-authenticated
 * observation of the *same* attempt; anything else keeps the stored attempt, so the review fails closed exactly
 * as before.
 */
function publicationAttempt(store: CollectorBridgeStore, attempt: AttemptRecord, packet: HandoffPacket | undefined, policy: ControllerAttestationPolicy): AttemptRecord {
  const claimed = packet?.observedRuntime;
  if (!claimed || canonicalJson(claimed) === canonicalJson(attempt.observedRuntime ?? null)) return attempt;
  if (!claimed.receiptEvidenceIds.length) return attempt;
  const candidate: AttemptRecord = { ...attempt, observedRuntime: claimed };
  for (const id of new Set(claimed.receiptEvidenceIds)) {
    const receipt = store.getEvidence(id);
    if (!receipt || authenticateControllerReceipt(receipt, candidate, policy).length) return attempt;
  }
  return candidate;
}

export interface PublishHandoffReviewsOptions {
  vault: EvidenceVault;
  store: CollectorBridgeStore;
  runId: string;
  reviewerId: string;
  /** Evaluation time, or a clock returning it (a fixed clock function is accepted for composition parity). */
  now: string | (() => string);
  controller: ControllerAttestationPolicy;
  /** Evidence ids explicitly admitted from earlier dependency attempts. */
  upstreamEvidenceIds?(attempt: AttemptRecord): readonly string[];
}

export interface HandoffPublication {
  readonly reviews: readonly HandoffReview[];
  /** Controller receipts independently re-attested for the publication; pass to `buildReport`. */
  readonly controllerReceipts: readonly EvidenceReceipt[];
}

function preservedPackets(vault: EvidenceVault, runId: string): Map<string, Array<{ receipt: EvidenceReceipt; packet: unknown }>> {
  const byAttempt = new Map<string, Array<{ receipt: EvidenceReceipt; packet: unknown }>>();
  for (const receipt of vault.list(runId)) {
    const metadata = receipt.metadata;
    if (metadata?.purpose !== PACKET_PURPOSE || metadata?.bridge !== BRIDGE_MARKER) continue;
    const attemptId = metadata.attemptId;
    if (typeof attemptId !== 'string' || !ID_PATTERN.test(attemptId)) continue;
    const bytes = vault.read(receipt.evidenceId);
    const parsed = parseJson(bytes);
    if (!parsed.ok) continue;
    const list = byAttempt.get(attemptId) ?? [];
    list.push({ receipt, packet: parsed.value });
    byAttempt.set(attemptId, list);
  }
  return byAttempt;
}

/**
 * Application-facing publication. Every durable store result must resolve to a vault-preserved
 * packet whose normalized digest equals the fenced admission digest; otherwise publication fails
 * closed. Only independently controller-attested runtime receipts are offered to the review.
 */
export function publishHandoffReviews(options: PublishHandoffReviewsOptions): HandoffPublication {
  const { vault, store } = options;
  const now = typeof options.now === 'function' ? options.now() : options.now;
  checkId(options.runId); checkId(options.reviewerId); checkTime(now);
  const run = store.getRun(options.runId);
  requireEvidence(run && run.runId === options.runId, 'publication-run', 'Publication requires the durable run');
  const results = store.listResults(options.runId);
  requireEvidence(results.length <= MAX_PUBLICATION_RESULTS, 'publication-limit', 'Publication result set exceeds its bound');
  const preserved = preservedPackets(vault, options.runId);
  const reviews: HandoffReview[] = [];
  const controller = new Map<string, EvidenceReceipt>();
  for (const result of results) {
    const attempt = store.getAttempt(result.attemptId);
    requireEvidence(attempt && attempt.runId === options.runId && attempt.taskId === result.taskId, 'publication-attempt', 'Publication result has no matching durable attempt');
    const task = store.getTask(result.taskId);
    requireEvidence(task && task.runId === options.runId, 'publication-task', 'Publication result has no matching durable task');
    const candidates = preserved.get(result.attemptId) ?? [];
    const match = candidates.find(candidate => digestJson(normalizeAttestedPacket(candidate.packet, result.packet.observedRuntime)) === result.digest);
    requireEvidence(match, 'packet-not-preserved', 'Publish only packets whose bytes were preserved by the result-collector bridge; admit collected results, not direct worker submissions');
    // Review the admitted packet against the observation it was admitted with, never against a later one.
    const reviewed = publicationAttempt(store, attempt, result.packet, options.controller);
    // Each observation authenticates only the receipts it lists, so both the attempt's latest observation and the
    // one the admitted packet pinned contribute controller-attested runtime evidence.
    const observations: Array<[AttemptRecord, readonly string[]]> = [[attempt, attempt.observedRuntime?.receiptEvidenceIds ?? []]];
    if (reviewed !== attempt) observations.push([reviewed, reviewed.observedRuntime?.receiptEvidenceIds ?? []]);
    for (const [context, ids] of observations) {
      for (const id of ids) {
        const receipt = store.getEvidence(id);
        if (!receipt || controller.has(id) || authenticateControllerReceipt(receipt, context, options.controller).length) continue;
        controller.set(id, receipt);
      }
    }
    // The review itself is fenced to the observation it compares against; the publication additionally reports
    // every authenticated observation of this attempt so the report can resolve the receipt it printed.
    const attested = (reviewed.observedRuntime?.receiptEvidenceIds ?? []).map(id => controller.get(id)).filter((receipt): receipt is EvidenceReceipt => !!receipt);
    reviews.push(reviewHandoff(vault, result.packet, {
      authorization: run.authorization, task, attempt: reviewed, reviewerId: options.reviewerId, now,
      ...(options.upstreamEvidenceIds ? { upstreamEvidenceIds: options.upstreamEvidenceIds(attempt) } : {}),
      ...(attested.length ? { controllerReceipts: attested } : {}),
    }));
  }
  return freeze({ reviews, controllerReceipts: [...controller.values()] });
}
