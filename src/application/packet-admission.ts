import { handoffSchema, type AttemptRecord } from '../contracts/index.js';
import type { DurableStore, StoredResult } from '../store/index.js';
import type { ResultCandidate } from '../orchestrator/index.js';

export interface PacketAdmissionIssue { code: string; path: string; message: string; question: string }
const SAFE_ERRORS = new Set(['packet-identity', 'result-identity', 'result-conflict', 'result-already-accepted', 'stale-result', 'packet-collection-failed']);
const ROOT_FIELDS = new Set(['schemaVersion', 'packetId', 'runId', 'taskId', 'attemptId', 'producer', 'consumer', 'createdAt', 'inputRevision', 'scope', 'question', 'classification', 'outcome', 'evidenceIds', 'limits', 'nextAction', 'requestedRuntime', 'observedRuntime', 'details']);
function schemaPath(path: string): string {
  const root = path.split('/')[1];
  // Unknown field names are attacker-controlled and can themselves contain secrets. Do not echo them.
  return ROOT_FIELDS.has(root ?? '') ? `$/${root}` : '$';
}
/** Called only AFTER the worker bridge authenticates this exact run/attempt/token/current lease. */
export async function admitAuthenticatedPacket(input: {
  attempt: AttemptRecord; store: DurableStore; now: () => string;
  collect: () => Promise<readonly ResultCandidate[]>;
  submit: (candidate: ResultCandidate) => Promise<StoredResult>;
}) {
  const { attempt, store } = input;
  const slot = store.reservePacketSubmission(attempt.runId, attempt.attemptId);
  const feedback = () => ({ controllerNow: input.now(), deadlineAt: attempt.deadlineAt,
    rejectedSubmissions: store.packetRejectionCount(attempt.runId, attempt.attemptId),
    remainingCorrections: Math.max(0, 2 - store.packetSubmissionSlots(attempt.runId, attempt.attemptId)) });
  if (!slot.allowed) return { accepted: false, evaluatedAt: input.now(), reasons: ['packet-rejection-limit'],
    issues: [{ code: 'packet-rejection-limit', path: '$', message: 'Submission/correction allowance is exhausted, including any interrupted prior submission', question: 'Stop this attempt and report its unresolved evidence gap.' }], ...feedback() };
  const issues: PacketAdmissionIssue[] = [];
  let evaluatedAt = input.now();
  let accepted = false;
  try {
    const candidates = await input.collect();
    if (!candidates.length) issues.push({ code: 'packet-missing', path: '$', message: 'No bounded packet candidate was collected', question: 'Supply one valid packet for this exact attempt.' });
    for (const candidate of candidates.slice(0, 4)) {
      const parsed = handoffSchema.safeParse(candidate.packet);
      if (!parsed.success) {
        issues.push(...parsed.issues.slice(0, 8).map(issue => ({ code: `schema:${issue.code}`.slice(0, 128), path: schemaPath(issue.path), message: 'Packet field does not satisfy the handoff schema', question: 'Supply the required schema field; preserve the controller identity and collector evidence.' })));
        continue;
      }
      const admission = await input.submit(candidate);
      evaluatedAt = admission.decision.evaluatedAt;
      if (admission.decision.status === 'accepted') { accepted = true; break; }
      issues.push(...admission.decision.reasons.slice(0, 8).map(issue => ({ code: issue.code.slice(0, 128), path: issue.path.slice(0, 256), message: issue.message.slice(0, 400), question: issue.question.slice(0, 400) })));
    }
  } catch (error) {
    // Never echo exception bodies/paths/provider data that might contain credentials. Only a bounded
    // machine code is retained; collection/identity/schema failures still consume the authenticated slot.
    const raw = error instanceof Error && 'code' in error ? String(error.code) : 'packet-collection-failed';
    const code = SAFE_ERRORS.has(raw) ? raw : 'packet-admission-failed';
    issues.push({ code, path: '$/packet', message: 'Controller packet collection or identity/schema admission failed', question: 'Read the current controller envelope; submit a valid packet for this attempt, never another attempt or fabricated evidence.' });
  }
  const bounded = issues.slice(0, 8);
  const reasons = [...new Set(bounded.map(issue => issue.code))];
  store.finishPacketSubmission(attempt.runId, attempt.attemptId, slot.slotId!, accepted, reasons);
  return { accepted, reasons: accepted ? [] : reasons, issues: accepted ? [] : bounded, evaluatedAt, ...feedback() };
}
