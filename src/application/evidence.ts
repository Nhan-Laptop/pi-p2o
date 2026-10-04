import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson, digestJson, type AttemptRecord, type Classification, type EvidenceKind, type EvidenceReceipt, type JsonObject, type JsonValue, type TaskManifest, type TestReceipt } from '../contracts/index.js';
import type { DurableStore } from '../store/index.js';
import { admitToolResult, sha256, type CollectorHandle, type EvidenceVault } from '../evidence/index.js';
import type { ToolResult } from '../tools/types.js';

export interface CollectorToolIdentity { name: string; version: string; implementationDigest: string }

export interface BrokerAdmission {
  result: ToolResult;
  operationInput: unknown;
  artifactRootId: string;
  /** Verifier evidence must be attributed to the verifier capability, never the collector default. */
  role?: 'collector' | 'verifier';
  collectorId?: string;
  evidence: {
    evidenceId: string;
    idempotencyKey?: string;
    kind: EvidenceKind;
    classification: Classification;
    summary: string;
    test?: TestReceipt;
    metadata?: JsonObject;
  };
}

export interface DocumentAdmission {
  evidenceId: string;
  kind: EvidenceKind;
  classification: Classification;
  summary: string;
  document: JsonValue;
  method: string;
  test?: TestReceipt;
  metadata?: JsonObject;
  role?: 'collector' | 'verifier';
  collectorId?: string;
  tool?: CollectorToolIdentity;
  environmentId?: string;
  configurationDigest?: string;
  inputDigests?: string[];
  scopeDigest?: string;
  collectedAt?: string;
  idempotencyKey?: string;
}

export interface CollectorBridge {
  /** Authenticate a real tool-broker result and write the receipt into the durable store. */
  admitBroker(attempt: AttemptRecord, admission: BrokerAdmission): EvidenceReceipt;
  /** Preserve a controller-authored document (environment/qualification receipt) and store the receipt. */
  admitDocument(attempt: AttemptRecord, admission: DocumentAdmission): EvidenceReceipt;
  /** Identity used when no explicit tool is supplied for a controller document. */
  readonly controllerTool: CollectorToolIdentity;
}

export interface CollectorBridgeOptions {
  vault: EvidenceVault;
  store: DurableStore;
  /** Artifact-root id used for controller-authored documents (must be a vault artifact root). */
  controllerArtifactRootId: string;
  /** Absolute canonical path of that same root (the vault resolves ids; the bridge must write bytes). */
  controllerArtifactRoot: string;
  /** Default controller tool identity; explicit per-call tool identities are also accepted. */
  controllerTool: CollectorToolIdentity;
  attempt(attemptId: string): AttemptRecord | undefined;
  task(taskId: string): TaskManifest | undefined;
  /** Policy digest bound to this attempt (must equal the broker receipt's scopeDigest). */
  scopeDigest(attemptId: string): string;
  /** Approved policy grant id for the attempt's task; it must match the broker context grantId. */
  grantIdFor(taskId: string): string;
  collectorId?: string;
}

function deadlineIso(attempt: AttemptRecord, task: TaskManifest): string {
  const candidates = [attempt.deadlineAt, task.budgets.deadlineAt].sort();
  return candidates[0]!;
}

/**
 * Supervisor-side collector bridge. It owns the only path from a collection to a durable receipt:
 * issue a bounded collector capability, verify the actual bytes, preserve them in the vault, and
 * only then write the store receipt. Workers never call it directly.
 */
export function createCollectorBridge(options: CollectorBridgeOptions): CollectorBridge {
  const defaultCollectorId = options.collectorId ?? 'p2o-collector';

  function issue(attempt: AttemptRecord, task: TaskManifest, input: {
    role: 'collector' | 'verifier'; collectorId: string; tool: CollectorToolIdentity; artifactRootId: string;
    environmentId: string; configurationDigest: string; inputDigests: string[]; scopeDigest: string;
    validFrom: string; expiresAt: string;
  }): CollectorHandle {
    return options.vault.issueCollector({
      collectorId: input.collectorId,
      role: input.role,
      runId: attempt.runId,
      taskId: attempt.taskId,
      attemptId: attempt.attemptId,
      authorizationRef: task.scope.authorizationRef,
      environmentId: input.environmentId,
      configurationDigest: input.configurationDigest,
      scopeDigest: input.scopeDigest,
      inputDigests: input.inputDigests,
      originalEnvironment: true,
      modifications: [],
      toolGrantId: options.grantIdFor(attempt.taskId),
      tool: { name: input.tool.name, version: input.tool.version, implementationDigest: input.tool.implementationDigest },
      artifactRootIds: [input.artifactRootId],
      allowedKinds: [...new Set([...BASE_KINDS, ...EXTRA_KINDS])],
      allowedClassifications: CLASSIFICATIONS,
      validFrom: input.validFrom,
      expiresAt: input.expiresAt,
    });
  }

  function put(receipt: EvidenceReceipt): EvidenceReceipt {
    const stored = options.store.putEvidence(receipt);
    if (stored.evidenceId !== receipt.evidenceId || stored.digest !== receipt.digest) {
      throw new Error('Store receipt identity changed during admission');
    }
    return stored;
  }

  return Object.freeze({
    controllerTool: options.controllerTool,
    admitBroker(attempt: AttemptRecord, admission: BrokerAdmission): EvidenceReceipt {
      const task = options.task(attempt.taskId);
      if (!task) throw new Error('Unknown task for broker admission');
      const receipt = admission.result.receipt;
      const tool = { name: receipt.tool.id, version: receipt.tool.version, implementationDigest: receipt.tool.implementationDigest };
      const role = admission.role ?? 'collector';
      const handle = issue(attempt, task, {
        role,
        collectorId: admission.collectorId ?? (role === 'verifier' ? 'p2o-independent-verifier' : options.collectorId ?? defaultCollectorId),
        tool,
        artifactRootId: admission.artifactRootId,
        environmentId: task.scope.environmentId,
        configurationDigest: task.scope.configurationDigest,
        inputDigests: task.scope.inputs.map(input => input.digest),
        scopeDigest: options.scopeDigest(attempt.attemptId),
        validFrom: attempt.createdAt,
        expiresAt: deadlineIso(attempt, task),
      });
      const admitted = admitToolResult(options.vault, handle, {
        result: admission.result,
        operationInput: admission.operationInput,
        artifactRootId: admission.artifactRootId,
        evidence: {
          evidenceId: admission.evidence.evidenceId,
          idempotencyKey: admission.evidence.idempotencyKey ?? admission.evidence.evidenceId,
          kind: admission.evidence.kind,
          classification: admission.evidence.classification,
          summary: admission.evidence.summary,
          ...(admission.evidence.test ? { test: admission.evidence.test } : {}),
          ...(admission.evidence.metadata ? { metadata: admission.evidence.metadata } : {}),
        },
      });
      return put(admitted.receipt);
    },
    admitDocument(attempt: AttemptRecord, admission: DocumentAdmission): EvidenceReceipt {
      const task = options.task(attempt.taskId);
      if (!task) throw new Error('Unknown task for document admission');
      const bytes = Buffer.from(`${canonicalJson(admission.document)}\n`, 'utf8');
      const relative = `${attempt.attemptId}/${admission.evidenceId}.json`;
      const absolute = join(options.controllerArtifactRoot, relative);
      mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
      writeFileSync(absolute, bytes, { mode: 0o600, flag: 'w' });
      const tool = admission.tool ?? options.controllerTool;
      const role = admission.role ?? 'collector';
      const collectedAt = admission.collectedAt ?? new Date().toISOString();
      const handle = issue(attempt, task, {
        role,
        collectorId: admission.collectorId ?? (role === 'verifier' ? 'p2o-independent-verifier' : defaultCollectorId),
        tool,
        artifactRootId: options.controllerArtifactRootId,
        environmentId: admission.environmentId ?? task.scope.environmentId,
        configurationDigest: admission.configurationDigest ?? task.scope.configurationDigest,
        inputDigests: admission.inputDigests ?? task.scope.inputs.map(input => input.digest),
        scopeDigest: admission.scopeDigest ?? options.scopeDigest(attempt.attemptId),
        validFrom: attempt.createdAt,
        expiresAt: deadlineIso(attempt, task),
      });
      const admitted = options.vault.admit(handle, {
        evidenceId: admission.evidenceId,
        idempotencyKey: admission.idempotencyKey ?? admission.evidenceId,
        artifact: { rootId: options.controllerArtifactRootId, path: relative, expectedDigest: sha256(bytes), expectedBytes: bytes.length, mediaType: 'application/json' },
        operationInputDigest: sha256(bytes),
        kind: admission.kind,
        classification: admission.classification,
        summary: admission.summary,
        collectedAt,
        method: admission.method,
        toolOptions: [],
        originalEnvironment: true,
        modifications: [],
        ...(admission.test ? { test: admission.test } : {}),
        ...(admission.metadata ? { metadata: admission.metadata } : {}),
      });
      return put(admitted.receipt);
    },
  });
}

const BASE_KINDS: EvidenceKind[] = ['source', 'observation', 'baseline', 'negative-control', 'reproduction', 'runtime', 'test', 'log'];
const EXTRA_KINDS: EvidenceKind[] = ['build', 'deployment', 'enforcement', 'trace', 'seed', 'coverage', 'sanitizer'];
const CLASSIFICATIONS: Classification[] = ['independently-observed', 'static-inference', 'unresolved'];

/** Deterministic self-identity for application-authored controller documents. */
export function controllerToolIdentity(name: string): CollectorToolIdentity {
  return { name, version: '1.0.0', implementationDigest: digestJson({ implementation: `pi-p2o/application/${name}`, version: '1.0.0' }) };
}
