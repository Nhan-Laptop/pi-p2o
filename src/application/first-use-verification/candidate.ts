import { digestJson, type EvidenceReceipt, type HandoffPacket, type TaskManifest } from '../../contracts/index.js';
import { receiptSupportsClaim, type EvidenceVault } from '../../evidence/index.js';
import type { ObservationCheck } from '../types.js';
import type { EvidenceBoundReplayCandidate } from './types.js';

/**
 * Post-admission, per-claim candidate selection.
 *
 * The producer's accepted H1 packet attributes a broad evidence set to the whole task. A verification leg may
 * only be built on the *exact* collector receipts of the owner-approved observation/negative-control/reproduction
 * checks, bound to the owner-approved claim, the producing attempt, the producer scope and the exact operation
 * input digest of each approved check. Worker-authored summaries, nearby packet receipts, task questions and
 * reset-dependent claims can never become a candidate here.
 */
export interface ProducerClaimEvidenceInput {
  vault: EvidenceVault;
  /** The durable, supervisor-admitted packet of the producing attempt. */
  packet: HandoffPacket;
  task: TaskManifest;
  /** Owner-derived finding identity and claim; never a task question. */
  findingId: string;
  claim: string;
  /** The exact owner-approved baseline observation check the controller verification program selected. */
  baselineCheck: ObservationCheck;
  /** Exactly one owner-approved negative control and one reproduction check for this claim. */
  controlCheck: ObservationCheck;
  reproductionCheck: ObservationCheck;
}

export interface SelectedProducerClaimEvidence {
  baseline: string;
  negativeControl: string;
  reproduction: string;
}

export type ProducerClaimEvidenceSelection =
  | { ok: true; candidate: EvidenceBoundReplayCandidate; evidence: SelectedProducerClaimEvidence }
  | { ok: false; reason: string };

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().join('\u0000') === [...right].sort().join('\u0000');
}

/** Every evidence kind this path can admit must still be an unmodified original-environment receipt. */
function fullPass(receipt: EvidenceReceipt): boolean {
  return !!receipt.test && receipt.test.outcome === 'passed' && receipt.test.originalPolicy && receipt.test.attempts > 0
    && receipt.test.successes === receipt.test.attempts && receipt.provenance.originalEnvironment;
}

function bounded(value: string | undefined): string {
  return typeof value === 'string' ? value.slice(0, 160) : 'unknown';
}

/**
 * Select the single receipt for one approved check out of the packet's attributed IDs, or explain exactly which
 * authenticated link is missing. A duplicate or a claim-unbound receipt is a refusal, never a best-effort pick.
 */
function receiptFor(input: ProducerClaimEvidenceInput, check: ObservationCheck, ids: readonly string[], requireClaim: boolean): { evidenceId: string } | { reason: string } {
  const matches: string[] = [];
  const rejected: string[] = [];
  for (const id of [...new Set(ids)]) {
    let receipt: EvidenceReceipt | undefined;
    let operationDigest: string | undefined;
    try {
      receipt = input.vault.get(id);
      operationDigest = input.vault.inspect(id)?.collector.operationInputDigest;
    } catch {
      rejected.push(`${id} failed integrity validation`);
      continue;
    }
    if (!receipt) { rejected.push(`${id} is not a trusted vault receipt`); continue; }
    if (receipt.taskId !== input.task.taskId || receipt.attemptId !== input.packet.attemptId) { rejected.push(`${id} belongs to another attempt/task`); continue; }
    if (receipt.kind !== check.kind || receipt.metadata?.observationId !== check.observationId) { rejected.push(`${id} is not the approved ${check.kind} ${check.observationId}`); continue; }
    if (operationDigest !== digestJson(check.input)) { rejected.push(`${id} was not collected for the exact approved input of ${check.checkId}`); continue; }
    if (receipt.provenance.environmentId !== input.task.scope.environmentId
      || receipt.provenance.configurationDigest !== input.task.scope.configurationDigest
      || !receipt.provenance.originalEnvironment
      || !sameSet(receipt.provenance.inputDigests, input.task.scope.inputs.map(entry => entry.digest))) {
      rejected.push(`${id} was collected outside the producer scope/inputs/environment`);
      continue;
    }
    if (requireClaim && (!receiptSupportsClaim(receipt, input.claim) || !fullPass(receipt))) {
      rejected.push(`${id} is not a passing control/reproduction receipt bound to the exact claim`);
      continue;
    }
    matches.push(id);
  }
  if (matches.length !== 1) {
    const detail = rejected.length ? ` rejected: ${rejected.slice(0, 3).map(bounded).join('; ')}` : '';
    return { reason: `expected exactly one authenticated receipt for approved ${check.kind} ${check.checkId}, found ${matches.length}${detail}` };
  }
  return { evidenceId: matches[0]! };
}

export function selectReceiptBoundProducerCandidate(input: ProducerClaimEvidenceInput): ProducerClaimEvidenceSelection {
  const claim = input.claim.trim();
  if (!claim || claim.endsWith('?') || claim === input.task.question.text) return { ok: false, reason: 'the owner-approved claim is empty, a question, or the task question itself' };
  if (input.baselineCheck.kind !== 'observation') return { ok: false, reason: 'the controller baseline check is not an observation check' };
  for (const [label, check] of [['negative-control', input.controlCheck], ['reproduction', input.reproductionCheck]] as const) {
    if (check.kind !== label) return { ok: false, reason: `the controller ${label} check is not an approved ${label} check` };
  }
  const baseline = receiptFor(input, input.baselineCheck, input.packet.evidenceIds, false);
  if ('reason' in baseline) return { ok: false, reason: `baseline: ${baseline.reason}` };
  const control = receiptFor(input, input.controlCheck, input.packet.limits.negativeControlEvidenceIds, true);
  if ('reason' in control) return { ok: false, reason: `negative control: ${control.reason}` };
  const reproduction = receiptFor(input, input.reproductionCheck, input.packet.evidenceIds, true);
  if ('reason' in reproduction) return { ok: false, reason: `reproduction: ${reproduction.reason}` };
  if (new Set([baseline.evidenceId, control.evidenceId, reproduction.evidenceId]).size !== 3) {
    return { ok: false, reason: 'the baseline, negative control and reproduction receipts are not three distinct collector receipts' };
  }
  const finding = {
    schemaVersion: 1 as const,
    findingId: input.findingId,
    runId: input.task.runId,
    taskId: input.task.taskId,
    producerId: input.packet.producer.id,
    title: `Bounded differential reproduction of the owner-approved observation: ${input.reproductionCheck.summary.slice(0, 380)}`,
    claim,
    state: 'reproduced' as const,
    classification: 'independently-observed' as const,
    evidenceIds: [reproduction.evidenceId],
    negativeControlEvidenceIds: [control.evidenceId],
    limitations: [
      `Bounded to the exact owner-approved read-only requests on target ${input.baselineCheck.surfaceId ?? input.task.scope.targetIds[0] ?? 'the approved target'} under the owner-approved account; no other path, method, account or state change was approved or exercised.`,
      'The producing attempt ran the owner-approved reproduction and negative control; promotion or rejection is decided only by the independent verifier replay in a fresh verifier attempt and environment.',
      'The verifier attempt/session is separate; targetReset=false. Passing read-only controls qualify only the current observable baseline, not a clean stateful target.',
      'No exploitability, impact, privilege escalation or post-exploitation capability is claimed; unsupported claims remain unresolved.',
    ],
  };
  return {
    ok: true,
    candidate: { finding, baselineEvidenceIds: [baseline.evidenceId], requiresTargetReset: false },
    evidence: { baseline: baseline.evidenceId, negativeControl: control.evidenceId, reproduction: reproduction.evidenceId },
  };
}
