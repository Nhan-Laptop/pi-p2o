import { digestJson } from '../contracts/index.js';
import { assertFindingReview, assertHandoffReview, checkId, EvidenceError, freeze, normalized, receiptSupportsClaim, type EvidenceVault, type FindingReview, type HandoffReview } from '../evidence/index.js';

export interface RemediationRecord {
  readonly schemaVersion: 1; readonly remediationId: string; readonly runId: string; readonly findingId: string;
  readonly packetId: string; readonly acceptedPacketDigest: string; readonly reviewerId: string; readonly recordedAt: string;
  readonly status: 'proposed' | 'unresolved'; readonly repairKind: 'root-cause' | 'exposure-mitigation' | 'unresolved';
  readonly invariant: string; readonly enforcementPoint: string; readonly affectedConsumers: readonly string[]; readonly variants: readonly string[];
  readonly regressionProperties: readonly string[]; readonly emergencyMitigation: string; readonly sourceShippedGap: string;
  readonly loggingRedaction: string; readonly evidenceIds: readonly string[]; readonly limitations: readonly string[];
}
export interface RetestRecord {
  readonly schemaVersion: 1; readonly retestId: string; readonly runId: string; readonly remediationId: string;
  readonly packetId: string; readonly acceptedPacketDigest: string; readonly reviewerId: string; readonly recordedAt: string;
  readonly closure: 'repaired' | 'exposure-mitigated' | 'partially-repaired' | 'unverified';
  readonly deployments: readonly { targetId: string; artifactDigest: string; revision: string; active: boolean }[];
  readonly acceptedControlEvidenceIds: readonly string[]; readonly forbiddenClassEvidenceIds: readonly string[];
  readonly evidenceIds: readonly string[]; readonly rollout: string; readonly activationRequirements: readonly string[];
  readonly compatibilityTradeoffs: readonly string[]; readonly residualRisks: readonly string[];
}
const remediations = new WeakMap<object, EvidenceVault>(), retests = new WeakMap<object, EvidenceVault>();
export function assertRemediation(record: RemediationRecord, vault: EvidenceVault): void {
  if (!record || remediations.get(record) !== vault) throw new EvidenceError('untrusted-remediation', 'Remediation records must derive from accepted H5 data');
}
export function assertRetest(record: RetestRecord, vault: EvidenceVault): void {
  if (!record || retests.get(record) !== vault) throw new EvidenceError('untrusted-retest', 'Retest closure must derive from accepted H6 data');
}
export function recordRemediation(vault: EvidenceVault, options: { remediationId: string; handoff: HandoffReview; finding: FindingReview }): RemediationRecord {
  checkId(options.remediationId); assertHandoffReview(options.handoff, vault); assertFindingReview(options.finding, vault);
  const p = options.handoff.packet, finding = options.finding.finding;
  if (options.handoff.decision.status !== 'accepted' || p?.contract !== 'H5' || options.finding.status !== 'accepted' || !finding || p.runId !== finding.runId || normalized(p.details.invariant) !== normalized(finding.claim)) throw new EvidenceError('remediation-binding', 'Remediation requires an accepted H5 contract tied to the accepted finding invariant');
  const d = p.details;
  const record: RemediationRecord = freeze({ schemaVersion: 1, remediationId: options.remediationId, runId: p.runId, findingId: finding.findingId,
    packetId: p.packetId, acceptedPacketDigest: digestJson(p), reviewerId: options.handoff.decision.reviewerId, recordedAt: options.handoff.decision.evaluatedAt,
    status: p.outcome === 'unresolved' || d.repairKind === 'unresolved' ? 'unresolved' : 'proposed', repairKind: d.repairKind,
    invariant: d.invariant, enforcementPoint: d.enforcementPoint, affectedConsumers: d.affectedConsumers, variants: d.variants,
    regressionProperties: d.regressionProperties, emergencyMitigation: d.emergencyMitigation, sourceShippedGap: d.sourceShippedGap, loggingRedaction: d.loggingRedaction,
    evidenceIds: [...new Set([...p.evidenceIds, ...d.acceptedControlEvidenceIds, ...d.rejectedCaseEvidenceIds])],
    limitations: [...p.limits.untestedScope, ...p.limits.failedAssumptions, ...p.limits.risks, 'H5 proposes repair; shipped/active enforcement closure requires a separate H6 retest.'],
  });
  remediations.set(record, vault); return record;
}
export function recordRetest(vault: EvidenceVault, options: { retestId: string; handoff: HandoffReview; remediation: RemediationRecord }): RetestRecord {
  checkId(options.retestId); assertHandoffReview(options.handoff, vault); assertRemediation(options.remediation, vault);
  const p = options.handoff.packet, remediation = options.remediation;
  if (options.handoff.decision.status !== 'accepted' || p?.contract !== 'H6' || p.runId !== remediation.runId) throw new EvidenceError('retest-binding', 'Retest requires an accepted H6 contract for the remediation run');
  const d = p.details;
  if (d.closure === 'repaired' && remediation.repairKind !== 'root-cause') throw new EvidenceError('retest-repair-kind', 'Exposure mitigation or unresolved repair cannot be relabelled root-cause closure');
  if (d.closure !== 'unverified') {
    const controls = [...d.acceptedControlEvidenceIds, ...d.forbiddenClassEvidenceIds].map(id => vault.get(id));
    if (controls.some(e => !e || !receiptSupportsClaim(e, remediation.invariant))) throw new EvidenceError('retest-invariant', 'Deployed original-policy controls must test the repaired invariant, not one unrelated sample');
  }
  const record: RetestRecord = freeze({ schemaVersion: 1, retestId: options.retestId, runId: p.runId, remediationId: remediation.remediationId,
    packetId: p.packetId, acceptedPacketDigest: digestJson(p), reviewerId: options.handoff.decision.reviewerId, recordedAt: options.handoff.decision.evaluatedAt,
    closure: d.closure, deployments: d.deploymentInventory, acceptedControlEvidenceIds: d.acceptedControlEvidenceIds, forbiddenClassEvidenceIds: d.forbiddenClassEvidenceIds,
    evidenceIds: [...new Set([...p.evidenceIds, ...d.sourceChangeEvidenceIds, ...d.buildEvidenceIds, ...d.deploymentEvidenceIds, ...d.enforcementEvidenceIds, ...d.acceptedControlEvidenceIds, ...d.forbiddenClassEvidenceIds])],
    rollout: d.rollout, activationRequirements: d.activationRequirements, compatibilityTradeoffs: d.compatibilityTradeoffs,
    residualRisks: [...d.residualRisks, ...p.limits.untestedScope, ...p.limits.failedAssumptions, ...p.limits.risks],
  });
  retests.set(record, vault); return record;
}
