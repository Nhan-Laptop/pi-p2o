import type { EvidenceReceipt, FindingRecord, CoverageRecord, ContractIssue } from './types.js';
import { contractIssue } from './scope.js';

export function validateEvidenceReferences(runId: string, ids: readonly string[], evidence: readonly EvidenceReceipt[]): ContractIssue[] {
  const known = new Map(evidence.map(e => [e.evidenceId, e]));
  return [...new Set(ids)].flatMap(id => {
    const e = known.get(id);
    return !e || e.runId !== runId ? [contractIssue('evidence-reference', '$/evidenceIds', 'Evidence is missing or belongs to another run', 'Supply immutable evidence admitted to this run.')] : [];
  });
}
export function validateCoverageEvidence(coverage: CoverageRecord, evidence: readonly EvidenceReceipt[]): ContractIssue[] {
  const issues = validateEvidenceReferences(coverage.runId, coverage.evidenceIds, evidence);
  const used = evidence.filter(e => coverage.evidenceIds.includes(e.evidenceId) && e.runId === coverage.runId);
  if (coverage.basis !== 'worker-asserted' && ['tested', 'ruled-out'].includes(coverage.state) && !used.some(e => e.provenance.trust === 'collector' && e.kind !== 'source')) issues.push(contractIssue('coverage-observation', '$/basis', 'Runtime/reviewer coverage needs collector observations', 'Preserve worker assertions or supply actual observed test receipts.'));
  if (coverage.state === 'ruled-out' && !used.some(e => e.provenance.trust === 'collector' && e.test?.outcome === 'passed' && e.test.originalPolicy)) issues.push(contractIssue('coverage-control', '$/state', 'Ruled-out question lacks a passing original-policy control', 'Supply a bounded negative control, or keep the question blocked/untested.'));
  return issues;
}
export function validateFindingEvidence(finding: FindingRecord, evidence: readonly EvidenceReceipt[]): ContractIssue[] {
  const ids = [...finding.evidenceIds, ...finding.negativeControlEvidenceIds, ...(finding.verifier?.evidenceIds ?? [])];
  const issues = validateEvidenceReferences(finding.runId, ids, evidence);
  const used = (refs: readonly string[]) => evidence.filter(e => refs.includes(e.evidenceId) && e.runId === finding.runId && e.provenance.trust === 'collector');
  const add = (code: string, message: string, question: string) => issues.push(contractIssue(code, '$/evidenceIds', message, question));
  if (finding.state === 'supported-static' && !used(finding.evidenceIds).some(e => e.kind === 'source')) add('finding-source', 'Static finding lacks source evidence', 'Supply the exact source/input revision supporting this inference.');
  if (['reproduced', 'independently-validated'].includes(finding.state)) {
    const reproductions = used(finding.evidenceIds).filter(e => e.kind === 'reproduction' && e.test?.purpose === 'reproduction' && e.test.outcome === 'passed' && e.test.originalPolicy && !!e.test.invariant);
    if (!reproductions.length) add('finding-reproduction', 'Finding has not reproduced under original policy with a declared invariant', 'Supply a collector reproduction receipt, not process exit or consensus.');
    if (!used(finding.negativeControlEvidenceIds).some(e => e.test?.purpose === 'negative-control' && e.test.outcome === 'passed' && e.test.originalPolicy && reproductions.some(r => r.test!.invariant === e.test!.invariant && r.provenance.environmentId === e.provenance.environmentId && r.provenance.configurationDigest === e.provenance.configurationDigest))) add('finding-negative-control', 'Comparable negative control is missing', 'Supply a passing negative control for the same invariant/environment/configuration.');
    if (finding.state === 'independently-validated') {
      const verifier = finding.verifier;
      const independent = verifier && used(verifier.evidenceIds).find(e => e.kind === 'reproduction' && e.test?.purpose === 'reproduction' && e.test.outcome === 'passed' && e.test.originalPolicy && e.attemptId === verifier.attemptId && e.provenance.collectorId === verifier.identity && e.provenance.environmentId === verifier.environmentId && verifier.identity !== finding.producerId && reproductions.some(r => r.attemptId !== e.attemptId && r.provenance.environmentId !== e.provenance.environmentId && r.test!.invariant === e.test!.invariant && r.provenance.inputDigests.some(digest => e.provenance.inputDigests.includes(digest))));
      if (!independent) add('finding-independence', 'Verifier has not independently reproduced in a distinct attempt/environment', 'Replay the smallest authorized check with a separate verifier in a clean environment.');
    }
  }
  return issues;
}
