import { createHash } from 'node:crypto';
import { SCHEMA_VERSION, canonicalJson, type Digest, type EvidenceReceipt, type Id, type JsonObject } from '../contracts/index.js';
import type { DurableStore } from '../store/index.js';
import type { RuntimeHandle } from '../runtime/types.js';
import type { ControlFiles } from './state-files.js';

export interface ControllerObservation {
  observation: 'live' | 'terminated' | 'not-started';
  status: string;
  adapter: string;
  requested: { provider: string; model: string; thinking: string };
  capabilities: JsonObject;
  deadlineAt: number;
  processIdentity?: { pid: number; hostId: string; startToken: string };
}

export interface ControllerReceiptInput {
  files: ControlFiles;
  store: DurableStore;
  controllerId: Id;
  environmentId: Id;
  configurationDigest: Digest;
  inputDigests: Digest[];
  handle: RuntimeHandle;
  now: string;
  observation: ControllerObservation;
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const receiptIdFor = (attemptId: string, sequence: number): Id => `rt-${sha256(attemptId).slice(0, 16)}-${sequence}`;

/**
 * Admits one controller-owned runtime observation as collector-trusted evidence.
 * The preserved artifact is this controller's own bounded observation document, never worker output.
 * It records identity/observation facts only; it is not artifact acceptance or finding verification.
 */
export function admitControllerReceipt(input: ControllerReceiptInput): Id {
  const { files, store, handle, observation } = input;
  const sequence = store.listEvidence(handle.runId).filter(e => e.attemptId === handle.attemptId).length + 1;
  const evidenceId = receiptIdFor(handle.attemptId, sequence);
  const document = {
    version: 1 as const,
    kind: 'p2o-controller-runtime-observation' as const,
    controllerId: input.controllerId,
    runId: handle.runId,
    taskId: handle.taskId,
    attemptId: handle.attemptId,
    observedAt: input.now,
    runtimeKind: handle.kind,
    runtimeStatus: observation.status,
    observation: observation.observation,
    ownerTokenDigest: sha256(handle.ownerToken).slice(0, 16),
    controlDirDigest: sha256(handle.controlDir).slice(0, 16),
    deadlineAt: observation.deadlineAt,
    requested: observation.requested,
    capabilities: observation.capabilities,
    ...(observation.processIdentity ? { processIdentity: observation.processIdentity } : {}),
  };
  const bytes = Buffer.from(`${canonicalJson(document)}\n`, 'utf8');
  files.writeRaw('receipts', evidenceId, bytes, 64 * 1024);
  const receipt: EvidenceReceipt = {
    schemaVersion: SCHEMA_VERSION,
    evidenceId,
    runId: handle.runId,
    taskId: handle.taskId,
    attemptId: handle.attemptId,
    kind: 'runtime',
    classification: 'independently-observed',
    digest: sha256(bytes),
    locator: `${files.root}/receipts/${evidenceId}.json`,
    mediaType: 'application/json',
    byteLength: bytes.byteLength,
    summary: `Controller-owned runtime observation (${observation.observation}) for attempt ${handle.attemptId}`,
    redacted: true,
    provenance: {
      collectorId: input.controllerId,
      trust: 'collector',
      method: 'supervisor ownership-handle reconciliation and adapter observation',
      collectedAt: input.now,
      tool: { name: 'p2o-supervisor', version: '1.0.0', options: ['runtime-observation'] },
      environmentId: input.environmentId,
      configurationDigest: input.configurationDigest,
      inputDigests: input.inputDigests,
      originalEnvironment: true,
      modifications: [],
    },
    metadata: {
      observation: observation.observation,
      runtimeStatus: observation.status,
      adapter: observation.adapter,
      deadlineAt: observation.deadlineAt,
    },
  };
  store.putEvidence(receipt);
  return evidenceId;
}
