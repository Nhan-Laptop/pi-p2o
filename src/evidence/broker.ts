import { canonicalJson, digestJson, makeSchema, rules as r, type EvidenceReceipt } from '../contracts/index.js';
import { CAPABILITIES } from '../policy/scope.js';
import type { ToolResult, ToolReceipt } from '../tools/types.js';
import { checkTime, digestRule, idRule, requireEvidence, timeRule } from './common.js';
import type { CollectorHandle, EvidenceAdmission, EvidenceSubmission, EvidenceVault } from './vault.js';

const artifactFields = r.object({ path: r.string({ maxLength: 4096 }), sha256: digestRule, bytes: r.number(true), mediaType: r.literal('application/json'), redacted: r.boolean() });
const receiptSchema = makeSchema<ToolReceipt>('broker-collection-receipt', r.object({
  version: r.literal(1), context: r.object({ runId: idRule, taskId: idRule, attemptId: idRule, grantId: idRule }),
  // The admissible tool identity is the installed capability list (plus the explicit `unprovisioned` marker), so
  // a capability the policy can grant - including the browser/proxy/fuzzing packs - is also admissible as
  // evidence, and a made-up capability can never be.
  tool: r.object({ id: r.enum([...CAPABILITIES, 'unprovisioned']), version: r.string(), implementationDigest: digestRule }),
  scopeDigest: digestRule, configurationDigest: digestRule, inputDigest: digestRule, startedAt: timeRule, finishedAt: timeRule,
  outcome: r.enum(['collected', 'denied', 'failed', 'cancelled']), errorCode: r.optional(r.string()), targets: r.array(idRule, 0, true),
  budgets: r.record(r.object({ requests: r.number(true), bytes: r.number(true), active: r.number(true), windowRequests: r.number(true) })),
  artifacts: r.array(artifactFields), isolation: r.string(), classification: r.literal('observation-not-verified-finding'),
}));
const artifactSchema = makeSchema<ToolResult['artifact']>('broker-artifact', artifactFields);
export interface ToolCollection {
  /** Returned by the trusted broker directly, never read from a worker's file. */
  result: ToolResult;
  operationInput: unknown;
  artifactRootId: string;
  evidence: Omit<EvidenceSubmission, 'artifact' | 'operationInputDigest' | 'collectedAt' | 'method' | 'toolOptions' | 'originalEnvironment' | 'modifications'>;
}
/** Authenticate a broker observation and compare its actual artifact, not its worker-visible data/prose. */
export function admitToolResult(vault: EvidenceVault, handle: CollectorHandle, collection: ToolCollection): EvidenceAdmission {
  const binding = vault.collectorGrant(handle), receipt = receiptSchema.parse(collection.result.receipt), output = artifactSchema.parse(collection.result.artifact);
  requireEvidence(receipt.outcome === 'collected' && !receipt.errorCode && receipt.artifacts.length === 1 && output.redacted && canonicalJson(output) === canonicalJson(receipt.artifacts[0]), 'broker-outcome', 'Only collected broker artifacts can support evidence admission');
  requireEvidence(receipt.context.runId === binding.runId && receipt.context.taskId === binding.taskId && receipt.context.attemptId === binding.attemptId && receipt.context.grantId === binding.toolGrantId, 'broker-identity', 'Broker context/grant does not match the supervisor collector');
  requireEvidence(receipt.tool.id === binding.tool.name && receipt.tool.version === binding.tool.version && receipt.tool.implementationDigest === binding.tool.implementationDigest, 'broker-tool', 'Broker tool/version/implementation identity changed');
  requireEvidence(receipt.scopeDigest === binding.scopeDigest && receipt.configurationDigest === binding.configurationDigest && receipt.inputDigest === digestJson(collection.operationInput), 'broker-input', 'Broker policy/configuration/operation-input identity differs');
  requireEvidence(checkTime(receipt.startedAt) >= checkTime(binding.validFrom) && checkTime(receipt.finishedAt) >= checkTime(receipt.startedAt) && checkTime(receipt.finishedAt) < checkTime(binding.expiresAt), 'broker-time', 'Broker observation is outside its collection window');
  const source: EvidenceSubmission['artifact'] = { rootId: collection.artifactRootId, path: output.path, expectedDigest: output.sha256, expectedBytes: output.bytes, mediaType: output.mediaType };
  const raw = vault.readCollected(handle, source);
  let collected: unknown;
  try { collected = JSON.parse(raw.toString('utf8')); } catch { throw new Error('Broker artifact must contain bounded JSON'); }
  requireEvidence(canonicalJson(collected) === canonicalJson(collection.result.data), 'broker-data', 'Worker-visible data differs from the authenticated broker artifact');
  const metadata = { ...collection.evidence.metadata, brokerOutcome: receipt.outcome, isolation: receipt.isolation, targets: [...receipt.targets], budgets: receipt.budgets } as NonNullable<EvidenceReceipt['metadata']>;
  return vault.admit(handle, { ...collection.evidence, artifact: source, operationInputDigest: receipt.inputDigest, collectedAt: receipt.finishedAt,
    method: 'authenticated tool broker collection', toolOptions: [], originalEnvironment: binding.originalEnvironment, modifications: [...binding.modifications], metadata });
}
