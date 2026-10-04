import { digestJson, type AttemptRecord, type JsonObject } from '../../contracts/index.js';
import type { CleanReplayBroker, CleanReplaySession, ReplayRequest } from '../../evidence/index.js';
import type { VerificationServices } from '../verification.js';
import type { FirstUseReplayPlan } from './types.js';

import { assertScopedVerificationPolicy, type ScopedVerificationPolicy } from './policy.js';
export interface FirstUseReplayEnvironmentOptions {
  /** Issued by controller from the actual verifier-attempt broker scope, not the producer grant. */
  verificationPolicy?: ScopedVerificationPolicy;
  replay: FirstUseReplayPlan;
  /** Exact owner-approved claim bound to the recipe invariant; a mismatch refuses before any receipt is minted. */
  claim: string;
  now?: () => string;
}

const REPLAY_METHODS = ['GET', 'HEAD'];

/**
 * Controller-owned independent verifier session provider.
 * Exact approved read-only requests only, through the normal scoped broker. The attempt/session identity
 * is separate from target state: targetReset=false, and no clean stateful target is claimed.
 * A receipt-backed baseline qualifies only the observable expected state.
 */
export function createFirstUseReplayEnvironment(services: VerificationServices, options: FirstUseReplayEnvironmentOptions): CleanReplayBroker {
  const now = options.now ?? (() => new Date().toISOString());
  const replay = structuredClone(options.replay);
  const claim = options.claim;
  const policy = options.verificationPolicy;
  const plan = replay.plan;
  const recipe = plan.recipe;
  const approvedUrls = new Set(replay.approvedUrls);
  const usedAttempts = new Set<string>();

  function refuse(reason: string): never {
    throw new Error(`first-use replay refused: ${reason}`);
  }

  function stepInput(step: 'baseline' | 'negativeControl' | 'probe'): { url: string; accountId: string; method: string } {
    const { url, accountId, method } = recipe[step].input;
    return { url, accountId, method: method ?? 'GET' };
  }

  function assertApprovedStep(step: 'baseline' | 'negativeControl' | 'probe'): void {
    const input = stepInput(step);
    if (!approvedUrls.has(input.url)) refuse(`recipe ${step} request ${input.url} is not one of the owner-approved request URLs`);
    const parsed = (() => { try { return new URL(input.url); } catch { return undefined; } })();
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
      refuse(`recipe ${step} request is not a credential-free scoped HTTP/HTTPS URL`);
    }
    if (parsed.origin !== replay.origin) refuse(`recipe ${step} request leaves the owner-approved origin ${replay.origin}`);
    if (!REPLAY_METHODS.includes(input.method)) refuse(`recipe ${step} request uses ${input.method}; only GET/HEAD are replayable`);
    if (!input.accountId) refuse(`recipe ${step} request names no approved account`);
  }

  function qualificationOf(attempt: AttemptRecord, taskId: string): JsonObject | undefined {
    const receipts = services.store.listEvidence(attempt.runId).filter(receipt => receipt.taskId === taskId);
    const qualification = receipts.find(receipt => receipt.attemptId === attempt.attemptId
      && receipt.kind === 'observation'
      && receipt.metadata !== undefined
      && receipt.metadata.observationId === replay.verifierObservationId);
    if (!qualification) return undefined;
    const admission = services.vault.inspect(qualification.evidenceId);
    if (!policy || !replay.verifierObservationInput || admission?.collector.role !== 'verifier'
      || admission.collector.scopeDigest !== policy.scopeDigest
      || admission.collector.operationInputDigest !== digestJson(replay.verifierObservationInput)) return undefined;
    const trusted = services.vault.get(qualification.evidenceId);
    const task = services.task(taskId);
    if (!trusted || !task || digestJson(trusted) !== digestJson(qualification) || trusted.runId !== attempt.runId
      || trusted.provenance.collectorId !== attempt.ownerId || !trusted.provenance.originalEnvironment
      || trusted.provenance.environmentId !== task.scope.environmentId || trusted.provenance.configurationDigest !== task.scope.configurationDigest
      || digestJson([...trusted.provenance.inputDigests].sort()) !== digestJson(task.scope.inputs.map(i => i.digest).sort())
      || admission.collector.authorizationDigest !== digestJson(task.scope.authorizationRef)
      || admission.collector.toolImplementationDigest !== services.httpTool.implementationDigest) return undefined;
    const data = JSON.parse(services.vault.read(trusted.evidenceId).toString('utf8')) as { kind?: string; status?: number; body?: string };
    const expected = recipe.baseline.expected;
    if (data.kind !== 'http' || data.status !== expected.status || (expected.bodyIncludes !== undefined && !data.body?.includes(expected.bodyIncludes))) return undefined;
    return {
      evidenceId: qualification.evidenceId,
      kind: qualification.kind,
      outcome: qualification.test?.outcome ?? null,
      observationId: String(qualification.metadata?.observationId ?? replay.verifierObservationId),
      digest: qualification.digest,
    };
  }

  return {
    async prepare(request: ReplayRequest): Promise<CleanReplaySession> {
      if (request.recipeDigest !== digestJson(recipe)) refuse('replay recipe differs from the exact controller-approved recipe');
      if (request.task.taskId !== plan.verifierTaskId) refuse(`verification plan names ${plan.verifierTaskId}, not ${request.task.taskId}`);
      if (request.attempt.taskId !== request.task.taskId || request.attempt.runId !== request.task.runId) refuse('verifier attempt does not belong to the verifier task');
      if (request.verifierId !== request.attempt.ownerId) refuse('verifier identity is not the live verifier attempt identity');
      const task = services.task(request.task.taskId);
      const attempt = services.attempt(request.attempt.attemptId);
      if (!task || !attempt) refuse('verifier task/attempt are not durable');
      if (recipe.targetId !== (request.task.scope.targetIds[0] ?? '') && !request.task.scope.targetIds.includes(recipe.targetId)) refuse('recipe target is outside the verifier task scope');
      if (digestJson(task) !== digestJson(request.task) || digestJson(attempt) !== digestJson(request.attempt)
        || !['running', 'waiting'].includes(attempt.lifecycleState) || Date.parse(now()) >= Date.parse(attempt.deadlineAt)) refuse('verifier durable identity is stale or altered');
      const inputDigests = request.task.scope.inputs.map(input => input.digest);
      if (inputDigests.length !== recipe.inputDigests.length || !inputDigests.every(digest => recipe.inputDigests.includes(digest))) {
        refuse('recipe input digests do not match the verifier task input revision');
      }
      if (recipe.invariant !== claim) refuse('recipe invariant no longer matches the owner-approved claim');
      assertApprovedStep('baseline');
      assertApprovedStep('negativeControl');
      assertApprovedStep('probe');
      if (digestJson(recipe.probe.violation) === digestJson(recipe.probe.safe)) refuse('replay predictions are not distinguishable');
      if (!policy) refuse('controller-authorized verifier policy required');
      assertScopedVerificationPolicy(policy);
      const context = { runId: task.runId, taskId: task.taskId, attemptId: attempt.attemptId, grantId: services.grantIdFor(task.taskId) };
      policy.assertVerifier(context);
      for (const step of ['baseline', 'negativeControl', 'probe'] as const) policy.assertRequest(context, recipe.targetId, stepInput(step));

      const replayId = request.replayId;
      const verifierSessionId = `session-${digestJson({ attemptId: attempt.attemptId, replayId }).slice(0, 24)}`;
      const environmentId = task.scope.environmentId;
      const qualification = qualificationOf(attempt, task.taskId);
      if (!qualification) refuse('verifier baseline lacks authenticated, passing observable qualification');
      if (usedAttempts.has(attempt.attemptId)) refuse('this verifier attempt already prepared its bounded replay; no implicit retry/reset');
      usedAttempts.add(attempt.attemptId);
      const environmentEvidenceId = `${replayId}.environment`;
      const environment = services.collector.admitDocument(attempt, {
        evidenceId: environmentEvidenceId,
        kind: 'runtime',
        classification: 'independently-observed',
        summary: `Independent verifier-owned replay session for ${replayId} (${replay.supportedClass}); target not reset`,
        document: {
          version: 1,
          kind: 'first-use-independent-replay-environment',
          replayId,
          findingId: plan.findingId,
          verifierId: request.verifierId,
          verifierTaskId: task.taskId,
          verifierAttemptId: attempt.attemptId,
          environmentId,
          verifierSessionId,
          targetReset: false,
          configurationDigest: task.scope.configurationDigest,
          isolation: task.scope.isolation,
          origin: replay.origin,
          fixtureId: recipe.fixtureId,
          supportedClass: replay.supportedClass,
          freshVerifierAttempt: true,
          fixtureReset: false,
          qualification: qualification ?? null,
          approvedSteps: (['baseline', 'negativeControl', 'probe'] as const).map(step => {
            const input = stepInput(step);
            return { step, method: input.method, accountId: input.accountId, urlDigest: digestJson(input.url) };
          }),
          predictions: { baseline: { ...recipe.baseline.expected }, negativeControl: { ...recipe.negativeControl.expected }, violation: { ...recipe.probe.violation }, safe: { ...recipe.probe.safe } },
          qualifiedAt: now(),
        },
        method: 'independent verifier attempt/broker session; exact approved recipe bound before replay; receipt-backed observable baseline (not target reset)',
        role: 'verifier',
        collectorId: request.verifierId,
        environmentId,
        inputDigests: recipe.inputDigests.map(digest => digest),
        metadata: {
          independentSession: true,
          recipeDigest: digestJson(recipe),
          targetReset: false,
          baselineQualified: true,
          qualification: `independent verifier attempt ${attempt.attemptId}; targetReset=false; observable baseline receipt ${qualification.evidenceId}`,
          replayId,
          findingId: plan.findingId,
          freshVerifierAttempt: true,
          fixtureReset: false,
          ...(qualification ? { qualificationEvidenceId: qualification.evidenceId } : {}),
        },
      });

      let closed: { receiptEvidenceId: string } | undefined;
      return {
        verificationPolicy: policy,
        environmentReceiptId: environment.evidenceId,
        context: { runId: task.runId, taskId: task.taskId, attemptId: attempt.attemptId, grantId: services.grantIdFor(task.taskId) },
        artifactRootId: services.artifactRootId,
        httpTool: services.httpTool,
        broker: services.brokerFor(attempt),
        async close(signal: AbortSignal): Promise<{ receiptEvidenceId: string }> {
          if (closed) return closed;
          const termination = services.collector.admitDocument(attempt, {
            evidenceId: `${replayId}.environment-terminated`,
            kind: 'runtime',
            classification: 'independently-observed',
            summary: `Verifier replay environment closed after ${replayId}`,
            document: {
              version: 1,
              kind: 'first-use-independent-replay-environment-termination',
              replayId,
              findingId: plan.findingId,
              verifierAttemptId: attempt.attemptId,
              environmentId,
              fixtureReset: false,
              abortRequested: signal.aborted,
              terminationConfirmed: true,
              terminatedAt: now(),
            },
            method: 'controller-owned verifier session close; the approved fixture itself was never owned or reset by this run',
            role: 'verifier',
            collectorId: request.verifierId,
            environmentId,
            inputDigests: recipe.inputDigests.map(digest => digest),
            metadata: { terminationConfirmed: true, replayId, findingId: plan.findingId, fixtureReset: false },
          });
          closed = { receiptEvidenceId: termination.evidenceId };
          return closed;
        },
      };
    },
  };
}
