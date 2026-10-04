import type { FindingRecord } from '../../contracts/index.js';
import { validateFinding, type EvidenceVault, type FindingReview } from '../../evidence/index.js';

export interface SourceClaimReference {
  evidenceId: string;
  path: string;
  /** Hash of preserved redacted UTF-8 file bytes, not a mutable working tree path. */
  fileHash: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  /** Separate unverified security hypothesis. Never used as the demonstrated static claim. */
  hypothesis: string;
}
export function sourcePropertyClaim(reference: SourceClaimReference): string {
  return `Source ${reference.path} lines ${reference.startLine}-${reference.endLine} contains ${JSON.stringify(reference.excerpt)}`;
}

/** Receipt-backed static property admission, not vulnerability confirmation and not automatic scan promotion.
 * Collector metadata.sourceClaim must carry the exact reference fields (excluding evidenceId), and claimDigest.
 * The source receipt must preserve the raw redacted file as text/plain. Aggregate lexical scans are insufficient.
 */
export function reviewSourceCandidate(vault: EvidenceVault, finding: FindingRecord, reference: SourceClaimReference, now: string): FindingReview {
  const receipt = vault.get(reference.evidenceId);
  const proof = receipt?.metadata?.sourceClaim;
  if (finding.state !== 'supported-static' || finding.classification !== 'static-inference'
    || finding.claim !== sourcePropertyClaim(reference) || !finding.evidenceIds.includes(reference.evidenceId)
    || !reference.hypothesis.trim() || !receipt || receipt.runId !== finding.runId || receipt.taskId !== finding.taskId
    || !proof || typeof proof !== 'object' || Array.isArray(proof)
    || Object.entries(reference).some(([key, value]) => key !== 'evidenceId' && proof[key] !== value)) {
    throw new Error('source candidate requires explicit hypothesis and exact collector-bound file hash/range reference');
  }
  return validateFinding(vault, {
    ...finding,
    title: `Static source property: ${reference.path}:${reference.startLine}-${reference.endLine}`,
    limitations: [...finding.limitations, `Unverified hypothesis: ${reference.hypothesis}`, 'Only the cited source property is demonstrated; no runtime reachability, exploitability, impact or vulnerability is confirmed.'],
  }, { reviewerId: 'first-use-source-reviewer', now });
}
