import { findingSchema, type AttemptRecord, type Authorization, type FindingRecord, type TaskManifest } from '../contracts/index.js';
import type { DurableStore } from '../store/index.js';
import {
  replayFinding, validateFinding,
  type CleanReplayBroker, type EvidenceVault, type FindingReview,
} from '../evidence/index.js';
import type { ToolBroker } from '../tools/types.js';
import type { CollectorBridge } from './evidence.js';
import { ApplicationError } from './validation.js';
import type { IndependentVerifier } from './types.js';

export interface VerificationServices {
  vault: EvidenceVault;
  store: DurableStore;
  collector: CollectorBridge;
  attempt(attemptId: string): AttemptRecord | undefined;
  task(taskId: string): TaskManifest | undefined;
  brokerFor(attempt: AttemptRecord): ToolBroker;
  verifierCollectorId: string;
  /** Approved policy grant id for the verifier task (must match the broker context). */
  grantIdFor(taskId: string): string;
  /** Vault artifact-root id where the broker writes collected artifacts. */
  artifactRootId: string;
  /** Pinned http.request tool identity from the composition's capability registry. */
  httpTool: { name: 'http.request'; version: string; implementationDigest: string };
}

export type CleanReplayEnvironmentFactory = (services: VerificationServices) => CleanReplayBroker;

export interface IndependentVerifierOptions extends VerificationServices {
  authorization: Authorization;
  reviewerId: string;
  producerFinding(findingId: string): FindingRecord | undefined;
  replay: CleanReplayBroker;
  clock?: () => string;
  /** Force one supervisor observation pass while the verifier attempt is still live. */
  tick?: () => Promise<void>;
}

/**
 * Thin adapter over the evidence module's independent replay. No identity, clean-environment, admission or
 * promotion check is reinterpreted here: `replayFinding` owns every gate, and the verifier identity is the
 * verifier attempt's own producing identity (`attempt.ownerId`), which the orchestrator now assigns per attempt.
 */
export function createIndependentVerifier(options: IndependentVerifierOptions): IndependentVerifier {
  const clock = options.clock ?? (() => new Date().toISOString());

  function producerReview(findingId: string): FindingReview {
    // Always re-derive from the durable accepted packet: a promoted review from an earlier verifier attempt must
    // never become the input of a later replay (replayFinding requires the current producer state).
    const finding = options.producerFinding(findingId);
    if (!finding) throw new ApplicationError('finding-missing', `No producer finding ${findingId} exists for an accepted packet`);
    return validateFinding(options.vault, finding, { reviewerId: options.reviewerId, now: clock() });
  }

  async function verify(input: Parameters<IndependentVerifier['verify']>[0]): ReturnType<IndependentVerifier['verify']> {
    const initial = producerReview(input.findingId);
    if (initial.status !== 'accepted' || !initial.finding) {
      return { status: 'returned-for-evidence', review: initial, evidenceIds: [], issues: initial.issues };
    }
    const finding = findingSchema.parse(initial.finding);
    if (finding.state === 'supported-static') {
      // Source-only classification is retained without execution; replayFinding applies the same rule.
      return { status: 'accepted', review: initial, evidenceIds: [], issues: [] };
    }
    const task = options.task(input.verifierTaskId);
    let attempt = options.attempt(input.verifierAttemptId);
    if (!attempt || !task) throw new ApplicationError('verifier-identity', 'Verification requires a durable verifier task and attempt');
    // The verifier worker may ask for the replay before the controller's next observation has advanced the
    // durable lifecycle from the initial observation to 'running'. Wait for that bounded state instead of
    // letting an authoritative replay guard reject a healthy verifier attempt.
    const readinessDeadline = Math.min(Date.now() + 5_000, Date.parse(attempt.deadlineAt));
    while (!['running', 'waiting'].includes(attempt.lifecycleState) && Date.now() < readinessDeadline) {
      if (options.tick) await options.tick();
      else await new Promise(resolve => setTimeout(resolve, 25));
      attempt = options.attempt(input.verifierAttemptId) ?? attempt;
    }
    const outcome = await replayFinding({
      vault: options.vault,
      broker: options.replay,
      finding,
      recipe: input.recipe,
      replayId: `${input.findingId}.${attempt.attemptId}`,
      verifierId: attempt.ownerId,
      verifierTask: task,
      verifierAttempt: attempt,
      authorization: options.authorization,
      clock,
      ...(input.maxMs === undefined ? {} : { maxMs: input.maxMs }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    // A non-accepted replay outcome (rejected/unresolved) records the verifier's own receipts on the finding
    // record. Re-validate that same record with its verifier attribution so the report can show an honest
    // rejection/unresolved state instead of refusing to build: attribution does not promote the finding, and
    // `replayFinding` still owns every gate that produced the state.
    if (outcome.status !== 'accepted' && outcome.review.status === 'accepted' && outcome.review.finding && outcome.evidenceIds.length) {
      const attributed = validateFinding(options.vault, {
        ...outcome.review.finding,
        verifier: { identity: attempt.ownerId, attemptId: attempt.attemptId, environmentId: task.scope.environmentId, evidenceIds: [...outcome.evidenceIds] },
      }, { reviewerId: options.reviewerId, now: clock() });
      return { status: 'returned-for-evidence', review: attributed, evidenceIds: [...outcome.evidenceIds], issues: [...outcome.issues, ...attributed.issues] };
    }
    return {
      status: outcome.status === 'accepted' ? 'accepted' : 'returned-for-evidence',
      review: outcome.review,
      evidenceIds: [...outcome.evidenceIds],
      issues: [...outcome.issues],
    };
  }

  return Object.freeze({ producerReview, verify });
}
