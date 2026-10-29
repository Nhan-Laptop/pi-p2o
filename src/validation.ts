import { sha256Hex } from './validate.js';
import type { AssessmentRecord, LedgerIndex } from './records.js';
import type { Candidate } from './evidence.js';
import { isSatisfiedTask, taskFrontier, type AssessmentTask, type TaskDraft } from './tasks.js';

/**
 * planning_update.md W4: the host, not the operator, owes one independent replay to a confirmed, tested claim. The task id is
 * derived from the run, the discovery task and the claim slug, so a duplicate candidate call cannot buy a second validation.
 */
export function validationKey(runId: string, claim: AssessmentRecord, discovery: AssessmentTask): string {
  const claimId = String(claim.data?.candidate ?? claim.id ?? 'claim');
  return `validation-${sha256Hex(JSON.stringify([runId, discovery.id, claimId])).slice(0, 40)}`;
}

const bounded = (value: string, max: number): string => value.length > max ? value.slice(0, max) : value;

/**
 * P21/A4: the replay facts a validation worker would otherwise have to guess. The run's validation workers reproduced the
 * effect but could not state what they had run; the brief now names the claim record, its receipts, the host replay unit and
 * how to materialize it, and asks whether the replay exercises the claimed mechanism or a short-circuit before it.
 */
function replayBrief(claim: AssessmentRecord): string {
  const units = Array.isArray(claim.data?.replayUnits) ? claim.data.replayUnits as Array<Record<string, unknown>> : [];
  const canonical = units[0];
  const payloadRef = typeof claim.data?.payloadRef === 'string' ? claim.data.payloadRef : typeof canonical?.payloadRef === 'string' ? canonical.payloadRef : undefined;
  const sha256 = typeof claim.data?.payloadSha256 === 'string' ? claim.data.payloadSha256 : typeof canonical?.sha256 === 'string' ? canonical.sha256 : undefined;
  const refs = (claim.refs ?? []).slice(0, 4);
  const parts = [`claim record ${claim.id}`];
  if (refs.length) parts.push(`its receipts: ${refs.join(', ')}`);
  parts.push(payloadRef
    ? `replay unit ${payloadRef}${sha256 ? ` sha256 ${sha256.slice(0, 16)}` : ''}; materialize it with p2o_lab action=payload id=${payloadRef} materialize=true`
    : 'no host replay unit was recorded for it');
  return parts.join('; ');
}

/** The one task-shaped draft an automatic validation uses; manual validation still goes through the same TaskBoard admission. */
export function validationDraft(claim: AssessmentRecord, candidate: Candidate, discovery: AssessmentTask): TaskDraft {
  const claimId = claim.id;
  if (!claimId) throw Error('A validation task needs a stored claim record ID');
  const name = String(candidate.candidate);
  // A structured discovery already has the exact asset/question identity validation must reproduce. A legacy task has none, so the
  // validation stays a legacy task too: validationOf + prerequisites are still checked, and the host does not invent an asset.
  const structured = discovery.work !== undefined && discovery.outputContract !== undefined;
  const work = structured ? { ...discovery.work!, purpose: 'validation' as const, claimRefs: [claimId] } : undefined;
  const expectation = candidate.expectedPolicy?.trim() ?? 'the claimed effect', control = candidate.control?.trim(), brief = replayBrief(claim);
  return {
    id: validationKey(discovery.runId, claim, discovery),
    question: bounded(`Independently reproduce ${name} with a fresh worker and its own receipt (${brief}). Decide whether the replay exercises the claimed mechanism or a short-circuit before it, then record one candidate with reproduces=${claimId}, your own receipts in evidenceRefs, and the same surface and risk.`, 1500),
    surface: discovery.surface,
    risk: discovery.risk,
    role: 'validation',
    roleReason: 'Host-created independent validation for a confirmed tested claim; a different worker must reproduce it',
    expectedTrue: bounded(`A different worker replays ${name} and observes: ${expectation}. The replay exercises the claimed mechanism, not a short-circuit before it, and is recorded with reproduces=${claimId}.`, 1000),
    expectedFalse: bounded(`The replay does not reproduce ${name}${control ? ` (control: ${control})` : ''}; record the mismatch and keep the claim unreviewed.`, 1000),
    stopCondition: 'Stop after one independent replay or a concrete prerequisite gap; no retry loop.',
    evidenceIds: [],
    prerequisites: [{ taskId: discovery.id, revision: discovery.revision }],
    validationOf: discovery.id,
    method: { skills: [], reason: 'Host-created validation; the claim records the method that actually ran.' },
    ...(structured ? {
      work,
      decision: { disposition: 'validate' as const, reason: 'Independently replay the posted claim once.', relatedTaskId: discovery.id },
      outputContract: discovery.outputContract!,
    } : {}),
  };
}

/**
 * Read-only independence check for one claim. A validation task counts only when it is reviewed/closed, was assigned to a different
 * actor, and cites at least one receipt that actor authored. Otherwise the exact reason is returned for the case/report.
 */
export function reviewedValidation(index: LedgerIndex, claim: AssessmentRecord, tasks = taskFrontier(index)): { current: boolean; reason?: string; taskId?: string } {
  const claimTask = typeof claim.data?.taskRef === 'string' ? claim.data.taskRef : undefined;
  const linked = tasks.filter(task => task.role === 'validation'
    && (task.work?.claimRefs?.includes(claim.id ?? '') || (claimTask !== undefined && task.validationOf === claimTask)));
  const reviewed = linked.find(task => isSatisfiedTask(task.status) && task.evidenceIds.length > 0);
  if (reviewed) {
    if (!reviewed.assignee) return { current: false, reason: `validation-not-assigned:${reviewed.id}`, taskId: reviewed.id };
    if (reviewed.assignee === claim.by) return { current: false, reason: `validation-not-separate:${reviewed.id}`, taskId: reviewed.id };
    if (!reviewed.evidenceIds.some(id => index.byId.get(id)?.by === reviewed.assignee))
      return { current: false, reason: `validation-evidence-not-own:${reviewed.id}`, taskId: reviewed.id };
    return { current: true, taskId: reviewed.id };
  }
  const pending = linked.at(-1);
  if (pending) {
    const detail = pending.missingPrerequisites?.[0] ?? (pending.status === 'blocked' ? pending.outcome : undefined);
    return { current: false, reason: `validation-${pending.status}:${pending.id}${detail ? `: ${detail}` : ''}`, taskId: pending.id };
  }
  if (claimTask !== undefined) {
    const discovery = tasks.find(task => task.id === claimTask);
    if (discovery && !isSatisfiedTask(discovery.status))
      return { current: false, reason: `validation-discovery-${discovery.status}:${discovery.id}` };
  }
  return { current: false, reason: 'validation-missing' };
}

/**
 * Case-level independence: a case may cite the validation task and the discovery task explicitly even when a lead-authored claim
 * was stamped with a different current task. Count only a cited, reviewed validation whose own receipt belongs to its assignee and
 * whose assignee differs from the discovery worker it replays.
 */
export function caseValidation(index: LedgerIndex, claims: AssessmentRecord[], caseTaskRefs: readonly { taskId: string }[], tasks = taskFrontier(index)): { current: boolean; reason?: string; taskId?: string } {
  const cited = new Set(caseTaskRefs.map(ref => ref.taskId));
  const discoveryIds = new Set<string>();
  for (const claim of claims) if (typeof claim.data?.taskRef === 'string') discoveryIds.add(claim.data.taskRef);
  for (const task of tasks) if (cited.has(task.id) && task.role !== 'validation') discoveryIds.add(task.id);
  const validationTasks = tasks.filter(task => task.role === 'validation' && cited.has(task.id)
    && isSatisfiedTask(task.status) && task.evidenceIds.length > 0 && task.validationOf !== undefined && discoveryIds.has(task.validationOf));
  for (const validation of validationTasks) {
    if (!validation.assignee) return { current: false, reason: `validation-not-assigned:${validation.id}`, taskId: validation.id };
    const discovery = tasks.find(task => task.id === validation.validationOf);
    if (!discovery?.assignee || discovery.assignee === validation.assignee)
      return { current: false, reason: `validation-not-separate:${validation.id}`, taskId: validation.id };
    if (!validation.evidenceIds.some(id => index.byId.get(id)?.by === validation.assignee))
      return { current: false, reason: `validation-evidence-not-own:${validation.id}`, taskId: validation.id };
    return { current: true, taskId: validation.id };
  }
  const checks = claims.map(claim => reviewedValidation(index, claim, tasks)), current = checks.find(check => check.current);
  if (current) return current;
  return checks.find(check => check.reason && check.reason !== 'validation-missing') ?? { current: false, reason: 'validation-missing' };
}
