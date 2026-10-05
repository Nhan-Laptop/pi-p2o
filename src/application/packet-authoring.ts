import type { AttemptRecord, TaskManifest } from '../contracts/index.js';

/** Envelope only: the controller supplies identity/time, never authors provider claims or evidence. */
export function packetAuthoringFor(task: TaskManifest, attempt: AttemptRecord, controllerNow: string, role: 'worker' | 'verifier' = 'worker') {
  return {
    controllerNow,
    deadlineAt: attempt.deadlineAt,
    publicationTime: controllerNow,
    timestampRule: 'Use publicationTime for createdAt when publishing now. Do not guess, advance time between retries, or alter receipt/runtime timestamps. The controller still rejects future packets.',
    envelope: {
      schemaVersion: 1, runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.attemptId,
      producer: { id: attempt.ownerId, role }, consumer: { id: 'p2o-reviewer', role: 'reviewer' },
      createdAt: controllerNow, inputRevision: task.inputRevision, scope: task.scope, question: task.question,
      requestedRuntime: attempt.requestedRuntime, observedRuntime: attempt.observedRuntime ?? null,
    },
    requirements: {
      H1: {
        required: 'details.interfaces must contain at least one prioritized actual entry: surfaceId, registration, handler, actorId, gate, processIdentity, formats, benignOperations, priority, priorityReason, evidenceIds, reachability; details.unresolvedRoutes is required.',
        observed: 'reachability=observed requires a controller observation/trace receipt for this interface. A source file is not dynamic reachability.',
        inferred: 'For local static analysis use reachability=inferred, a nonempty proposedCheck and source evidenceIds. Name the real registration/handler/gate from the source; state uncertainty, do not invent a handler or claim execution.',
        actor: `actorId must equal scope.actor.id (${task.scope.actor.id}). Give formats, benignOperations and a substantive priorityReason.`,
        limits: 'Use classification=static-inference and outcome=static-only for source-only conclusions; disclose untested runtime scope. Unsupported facts stay unresolved, never supported by placeholders.',
      },
      H2: {
        required: 'Supply a source-backed minimal slice/invariant, distinguishable predictions, constraints and observation points. Supported outcomes need passed controller baseline and negative-control receipts.',
        limits: 'Use only the approved observation menu; a missing baseline/control/reproduction is a reason to report a gap, not invent a test or evidenceId.',
      },
    },
    retryRule: 'At most two rejected submissions per attempt, durably counted by the controller across restarts. Correct exactly returned paths/questions; do not regenerate the same invalid packet indefinitely.',
  };
}
