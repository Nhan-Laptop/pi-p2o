import { describe, it, expect } from 'vitest';
import { digestJson } from '../../src/contracts/index.js';
import type { ObservationCheck } from '../../src/application/types.js';
import { selectReceiptBoundProducerCandidate, firstUseFindingId } from '../../src/application/first-use-verification/index.js';
import { createHarness, CLAIM } from '../evidence/fixtures.js';

const OTHER_CLAIM = 'A different owner-approved claim that no receipt in this fixture is bound to.';

/** Pure in-process receipts: this file exercises only the per-claim selection gate, not a live target. */
function setup() {
  const h = createHarness();
  const checks: ObservationCheck[] = (['observation', 'negative-control', 'reproduction'] as const).map((kind, index) => ({
    checkId: `check-${index}`, observationId: `obs-${index}`, taskId: h.task.taskId, tool: 'http.request',
    input: { url: `http://127.0.0.1:9/lab/${index}`, method: 'GET', accountId: 'anonymous', action: 'read' },
    kind, classification: 'independently-observed', summary: `${kind} fixture`,
    expectation: { type: 'http', status: 200 },
  }));
  const collect = (id: string, kind: ObservationCheck['kind'], check: ObservationCheck, overrides: Record<string, unknown> = {}) => h.collect(id, kind, {
    operationInputDigest: digestJson(check.input), metadata: { observationId: check.observationId, claimDigest: digestJson(CLAIM) }, ...overrides,
  });
  collect('baseline', 'observation', checks[0]!);
  collect('control', 'negative-control', checks[1]!);
  collect('repro', 'reproduction', checks[2]!);
  const packet = {
    packetId: 'packet-candidate', runId: h.run.runId, taskId: h.task.taskId, attemptId: h.attempt.attemptId,
    producer: { id: h.attempt.ownerId, role: 'worker' },
    evidenceIds: ['baseline', 'repro'], limits: { negativeControlEvidenceIds: ['control'] },
  } as never;
  const input = {
    vault: h.vault, packet, task: h.task, findingId: firstUseFindingId(h.task.taskId, CLAIM), claim: CLAIM,
    baselineCheck: checks[0]!, controlCheck: checks[1]!, reproductionCheck: checks[2]!,
  };
  return { h, checks, input, collect, packet: packet as unknown as { evidenceIds: string[]; limits: { negativeControlEvidenceIds: string[] }; attemptId: string } };
}

describe('per-claim candidate selection (controller receipts only)', () => {
  it('selects exactly one claim-bound receipt per approved role and keeps the baseline separate', () => {
    const s = setup();
    try {
      const selection = selectReceiptBoundProducerCandidate(s.input);
      expect(selection.ok).toBe(true);
      if (!selection.ok) return;
      expect(selection.evidence).toEqual({ baseline: 'baseline', negativeControl: 'control', reproduction: 'repro' });
      expect(selection.candidate.baselineEvidenceIds).toEqual(['baseline']);
      expect(selection.candidate.finding.evidenceIds).toEqual(['repro']);
      expect(selection.candidate.finding.negativeControlEvidenceIds).toEqual(['control']);
      expect(selection.candidate.finding.claim).toBe(CLAIM);
      expect(selection.candidate.finding.state).toBe('reproduced');
      expect(selection.candidate.requiresTargetReset).toBe(false);
      expect(selection.candidate.finding.claim).not.toBe(s.input.task.question.text);
    } finally { s.h.dispose(); }
  });

  it('refuses a missing, forged or foreign-attempt packet receipt instead of substituting packet attribution', () => {
    const s = setup();
    try {
      expect(selectReceiptBoundProducerCandidate({ ...s.input, packet: { ...s.packet, evidenceIds: ['forged', 'repro'] } as never }).ok).toBe(false);
      // The packet may attribute the reproduction, but not the baseline observation.
      expect(selectReceiptBoundProducerCandidate({ ...s.input, packet: { ...s.packet, evidenceIds: ['control', 'repro'] } as never }).ok).toBe(false);
      expect(selectReceiptBoundProducerCandidate({ ...s.input, packet: { ...s.packet, attemptId: 'foreign-attempt' } as never }).ok).toBe(false);
    } finally { s.h.dispose(); }
  });

  it('refuses a claim-unbound, non-passing or duplicated control/reproduction receipt', () => {
    const s = setup();
    try {
      // A reproduction receipt bound to a different claim (digest and invariant) cannot stand in for this claim.
      s.collect('repro-other', 'reproduction', s.checks[2]!, {
        metadata: { observationId: s.checks[2]!.observationId, claimDigest: digestJson(OTHER_CLAIM) },
        test: { purpose: 'reproduction', outcome: 'passed', successes: 1, attempts: 1, invariant: OTHER_CLAIM, originalPolicy: true, targetId: 'fixture' },
      });
      expect(selectReceiptBoundProducerCandidate({ ...s.input, packet: { ...s.packet, evidenceIds: ['baseline', 'repro-other'] } as never }).ok).toBe(false);
      // Two matching reproduction receipts are ambiguous, never a best-effort pick.
      s.collect('repro-second', 'reproduction', s.checks[2]!);
      expect(selectReceiptBoundProducerCandidate({ ...s.input, packet: { ...s.packet, evidenceIds: ['baseline', 'repro', 'repro-second'] } as never }).ok).toBe(false);
      // A failed reproduction receipt cannot be promoted by selection.
      s.collect('repro-failed', 'reproduction', s.checks[2]!, { test: { purpose: 'reproduction', outcome: 'failed', successes: 0, attempts: 1, invariant: CLAIM, originalPolicy: true, targetId: 'fixture' } });
      expect(selectReceiptBoundProducerCandidate({ ...s.input, packet: { ...s.packet, evidenceIds: ['baseline', 'repro-failed'] } as never }).ok).toBe(false);
      // A control collected against a different operation input cannot authenticate the approved check.
      s.collect('control-drift', 'negative-control', s.checks[1]!, { operationInputDigest: digestJson({ url: 'http://127.0.0.1:9/lab/drift' }) });
      expect(selectReceiptBoundProducerCandidate({ ...s.input, packet: { ...s.packet, limits: { negativeControlEvidenceIds: ['control-drift'] } } as never }).ok).toBe(false);
    } finally { s.h.dispose(); }
  });

  it('refuses a question-shaped or task-question claim, and any reset-dependent candidate is never produced', () => {
    const s = setup();
    try {
      expect(selectReceiptBoundProducerCandidate({ ...s.input, claim: s.input.task.question.text }).ok).toBe(false);
      expect(selectReceiptBoundProducerCandidate({ ...s.input, claim: `${CLAIM}?` }).ok).toBe(false);
      expect(selectReceiptBoundProducerCandidate({ ...s.input, claim: '   ' }).ok).toBe(false);
    } finally { s.h.dispose(); }
  });

  it('refuses when a role check is not the approved role shape', () => {
    const s = setup();
    try {
      expect(selectReceiptBoundProducerCandidate({ ...s.input, controlCheck: s.checks[0]! }).ok).toBe(false);
      expect(selectReceiptBoundProducerCandidate({ ...s.input, reproductionCheck: s.checks[1]! }).ok).toBe(false);
      expect(selectReceiptBoundProducerCandidate({ ...s.input, baselineCheck: s.checks[2]! }).ok).toBe(false);
    } finally { s.h.dispose(); }
  });
});
