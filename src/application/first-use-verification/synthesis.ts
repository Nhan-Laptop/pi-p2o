import { digestJson } from '../../contracts/index.js';
import type { TaskManifest } from '../../contracts/index.js';
import type { HttpPrediction, LocalReplayRecipe } from '../../evidence/index.js';
import type { FindingPlan, ObservationCheck, VerificationPlan } from '../types.js';
import {
  FIRST_USE_REPLAY_CLASS,
  type FirstUseVerificationDraft,
  type FirstUseVerificationInput,
  type FirstUseVerificationLeg,
  type FirstUseVerificationPlanning,
  type FirstUseVerificationPlanningInput,
  type FirstUseVerificationSynthesis,
  type FirstUseReplayPlan,
} from './types.js';

const REPLAY_METHODS = ['GET', 'HEAD'] as const;
import { validateFinding, receiptSupportsClaim } from '../../evidence/verification.js';
import { assertScopedVerificationPolicy } from './policy.js';
const REPLAY_STEPS = 3;
const VERIFIER_OBSERVATIONS = 1;
const REPLAY_RESPONSE_BYTES = 65_536;
const REPLAY_MAX_MS = 15_000;

interface ApprovedRequest {
  url: string;
  method: (typeof REPLAY_METHODS)[number];
  accountId: string;
  maxResponseBytes?: number;
}

function refuse(reason: string): FirstUseVerificationSynthesis {
  return { supported: false, reason };
}

function planningRefuse(reason: string): FirstUseVerificationPlanning {
  return { supported: false, reason };
}

/** Read one approved read-only request out of an owner-approved check; a string return is a refusal reason. */
function approvedRequestOf(check: ObservationCheck): ApprovedRequest | string {
  if (check.tool !== 'http.request') return `owner-approved check ${check.checkId} is not an http.request observation`;
  const raw = (check.input ?? {}) as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['url', 'method', 'action', 'accountId', 'maxResponseBytes', 'maxRedirects'].includes(key))) return `owner-approved check ${check.checkId} has unsupported headers/body or execution fields`;
  if (raw.maxRedirects !== undefined && raw.maxRedirects !== 0) return `owner-approved check ${check.checkId} requests redirects outside the bounded class`;
  if (raw.maxResponseBytes !== undefined && (!Number.isSafeInteger(raw.maxResponseBytes) || (raw.maxResponseBytes as number) < 1 || (raw.maxResponseBytes as number) > 65_536)) return `owner-approved check ${check.checkId} has unsupported response cap`;
  const input = (check.input ?? {}) as { url?: unknown; method?: unknown; action?: unknown; accountId?: unknown };
  if (typeof input.url !== 'string' || !input.url) return `owner-approved check ${check.checkId} has no concrete URL`;
  const method = typeof input.method === 'string' ? input.method : 'GET';
  if (!(REPLAY_METHODS as readonly string[]).includes(method)) return `owner-approved check ${check.checkId} uses ${method}; only GET/HEAD are replayable`;
  if ((typeof input.action === 'string' ? input.action : 'read') !== 'read') return `owner-approved check ${check.checkId} is not a read-only action`;
  if (typeof input.accountId !== 'string' || !input.accountId) return `owner-approved check ${check.checkId} names no approved account`;
  return { url: input.url, method: method as ApprovedRequest['method'], accountId: input.accountId, ...(raw.maxResponseBytes === undefined ? {} : { maxResponseBytes: raw.maxResponseBytes as number }) };
}

/** The controller-evaluated positive observable of an approved check; a string return is a refusal reason. */
function predictionOf(check: ObservationCheck): HttpPrediction | string {
  const expectation = check.expectation;
  if (!expectation) return `owner-approved check ${check.checkId} declares no expectation, so no replay prediction exists`;
  if (expectation.type !== 'http') return `owner-approved check ${check.checkId} has a non-http expectation; only http observations are replayable`;
  if (expectation.mustMatch === false) return `owner-approved check ${check.checkId} declares a negative expectation; a replayable step needs the positive observable the original policy must produce`;
  return { status: expectation.status, ...(expectation.bodyIncludes === undefined ? {} : { bodyIncludes: expectation.bodyIncludes }) };
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function withinApprovedTarget(candidate: URL, approved: URL): boolean {
  if (candidate.origin !== approved.origin) return false;
  if (candidate.username || candidate.password || candidate.hash) return false;
  const base = approved.pathname.replace(/\/+$/u, '');
  return base === '' || candidate.pathname === base || candidate.pathname.startsWith(`${base}/`);
}

/** Deterministic owner-derived finding identity; the same claim on the same producer task never mints two. */
export function firstUseFindingId(taskId: string, claim: string): string {
  return `finding-${digestJson({ taskId, claim }).slice(0, 24)}`;
}

/**
 * The concrete claim the owner already approved with the plan: the reproduction check's controller-recorded
 * objective, carried either as the controller test invariant or as the check's own bounded summary. A missing,
 * question-shaped or ambiguous reproduction check never yields a claim.
 */
export function ownerApprovedClaimForChecks(checks: readonly ObservationCheck[]): { ok: true; claim: string } | { ok: false; reason: string } {
  // The structural split is reported first so a plan with no distinguishable differential names the missing
  // negative control/reproduction rather than a claim-shaped symptom.
  const controls = checks.filter(check => check.kind === 'negative-control');
  if (controls.length !== 1) return { ok: false, reason: `the owner-approved plan contains ${controls.length} negative-control checks; the bounded replay class needs exactly one` };
  const reproductions = checks.filter(check => check.kind === 'reproduction');
  if (reproductions.length !== 1) return { ok: false, reason: `the owner-approved plan contains ${reproductions.length} reproduction checks; a bounded claim needs exactly one` };
  const check = reproductions[0]!;
  const claim = (check.test?.invariant ?? check.summary).trim();
  if (!claim || claim.endsWith('?')) return { ok: false, reason: `owner-approved reproduction check ${check.checkId} carries no concrete bounded claim` };
  return { ok: true, claim };
}

/**
 * The complete owner-derived verification program identity: recipe, plans, verifier task/check and the
 * controller-enriched owner checks. It is a pure function of the owner-approved checks, the producing task/run,
 * the derived claim and the bounded verifier reserve, so the owner grant can authorize its task identity before
 * any evidence exists while admission itself stays gated on the post-admission receipt-backed candidate.
 */
interface FirstUseVerificationProgram {
  claim: string;
  approvedTarget: URL;
  baselineCandidate: ObservationCheck;
  control: ObservationCheck;
  reproduction: ObservationCheck;
  baselineRequest: ApprovedRequest;
  controlRequest: ApprovedRequest;
  reproductionRequest: ApprovedRequest;
  baseline: HttpPrediction;
  safe: HttpPrediction;
  violation: HttpPrediction;
  findingId: string;
  verifierTaskId: string;
  verifierObservationId: string;
  verifierCheckId: string;
  recipe: LocalReplayRecipe;
  verification: VerificationPlan;
  verifierTask: TaskManifest;
  verifierCheck: ObservationCheck;
  enrichedChecks: ObservationCheck[];
  finding: FindingPlan;
  replay: FirstUseReplayPlan;
}

/**
 * Turn an owner-approved request set into the *smallest* authorized verification program, or explain exactly why
 * no honest verification leg exists. This function never invents a request, prediction, account or target: every
 * field comes from one already owner-approved check.
 */
function planFirstUseVerificationProgram(input: FirstUseVerificationPlanningInput, claim: string, findingId: string): { program: FirstUseVerificationProgram } | { reason: string } {
  if (!claim.trim() || claim.trim().endsWith('?') || claim === input.producerTask.question.text) return { reason: 'candidate must assert a concrete claim, not a task question' };
  const approvedTarget = parseUrl(input.targetLocator);
  if (!approvedTarget) return { reason: 'the owner-approved target locator is not a parseable absolute URL' };

  const observations = input.checks.filter(check => check.kind === 'observation');
  const controls = input.checks.filter(check => check.kind === 'negative-control');
  const reproductions = input.checks.filter(check => check.kind === 'reproduction');
  if (controls.length !== 1) return { reason: `the owner-approved plan contains ${controls.length} negative-control checks; the bounded replay class needs exactly one` };
  if (reproductions.length !== 1) return { reason: `the owner-approved plan contains ${reproductions.length} reproduction checks; the bounded replay class needs exactly one` };
  if (!observations.length) return { reason: 'the owner-approved plan contains no observation check to use as the replay baseline' };

  const control = controls[0]!;
  const reproduction = reproductions[0]!;
  const controlRequest = approvedRequestOf(control);
  if (typeof controlRequest === 'string') return { reason: controlRequest };
  const reproductionRequest = approvedRequestOf(reproduction);
  if (typeof reproductionRequest === 'string') return { reason: reproductionRequest };
  const safe = predictionOf(control);
  if (typeof safe === 'string') return { reason: safe };
  const violation = predictionOf(reproduction);
  if (typeof violation === 'string') return { reason: violation };
  if (digestJson(violation) === digestJson(safe)) return { reason: 'the owner-approved reproduction and negative control declare the same observable, so the replay could not distinguish them' };
  if (controlRequest.accountId !== reproductionRequest.accountId) return { reason: 'the owner-approved control and reproduction use different accounts; the replay must stay on one approved account' };
  if (controlRequest.url === reproductionRequest.url) return { reason: 'the owner-approved control and reproduction are the same request URL; no differential exists' };

  const baselineCandidate = observations.find(candidate => {
    const request = approvedRequestOf(candidate);
    return typeof request !== 'string'
      && request.url !== controlRequest.url && request.url !== reproductionRequest.url
      && request.accountId === controlRequest.accountId;
  });
  if (!baselineCandidate) return { reason: 'no owner-approved observation differs from both the control and the reproduction on the same approved account' };
  const baselineRequest = approvedRequestOf(baselineCandidate);
  if (typeof baselineRequest === 'string') return { reason: baselineRequest };
  const baseline = predictionOf(baselineCandidate);
  if (typeof baseline === 'string') return { reason: baseline };

  const parsed = [baselineRequest, controlRequest, reproductionRequest].map(request => parseUrl(request.url));
  if (parsed.some(url => !url)) return { reason: 'an owner-approved request URL is not a parseable absolute URL' };
  const [parsedBaseline, parsedControl, parsedReproduction] = parsed as [URL, URL, URL];
  for (const url of [parsedBaseline, parsedControl, parsedReproduction]) {
    if (!withinApprovedTarget(url, approvedTarget)) return { reason: `owner-approved request ${url.href} leaves the exact approved target origin/path prefix` };
  }

  // The owner-approved run budget must still fit every approved check plus the bounded replay and the
  // verifier's own baseline observation. Below that the leg is refused rather than silently borrowing authority.
  if (input.run.budgets.maxRequests < input.checks.length + REPLAY_STEPS + VERIFIER_OBSERVATIONS) {
    return { reason: `the approved run request budget (${input.run.budgets.maxRequests}) leaves no room for ${REPLAY_STEPS} bounded replay requests after ${input.checks.length} approved checks` };
  }
  if (input.run.budgets.maxToolCalls < input.checks.length + REPLAY_STEPS + VERIFIER_OBSERVATIONS) {
    return { reason: 'the approved run tool-call budget leaves no room for the bounded replay' };
  }
  if (input.verifierBudget.maxRequests < 4 || input.verifierBudget.maxToolCalls < 4) return { reason: 'verifier caps do not permit four requests/tool calls' };

  const verifierTaskId = `verify-${digestJson({ findingId, targetId: input.targetId }).slice(0, 24)}`;
  const verifierObservationId = `vobs-${digestJson({ verifierTaskId, baseline: baselineRequest.url }).slice(0, 24)}`;
  const verifierCheckId = `vchk-${digestJson({ verifierTaskId, observationId: verifierObservationId }).slice(0, 24)}`;

  const recipe: LocalReplayRecipe = {
    recipeId: `recipe-${findingId.slice('finding-'.length)}`,
    fixtureId: `fixture-${digestJson(parsedControl.origin).slice(0, 16)}`,
    targetId: input.targetId,
    invariant: claim,
    inputDigests: input.producerTask.scope.inputs.map(entry => entry.digest),
    baseline: { input: { ...baselineRequest }, expected: baseline },
    negativeControl: { input: { ...controlRequest }, expected: safe },
    probe: { input: { ...reproductionRequest }, violation, safe },
  };
  const verification: VerificationPlan = {
    verifierTaskId,
    producerTaskId: input.producerTask.taskId,
    findingId,
    recipe,
    maxMs: REPLAY_MAX_MS,
  };

  const verifierTask: TaskManifest = {
    schemaVersion: 1,
    runId: input.run.runId,
    taskId: verifierTaskId,
    dependencyTaskIds: [input.producerTask.taskId],
    parentTaskId: input.producerTask.taskId,
    depth: 1,
    createdAt: input.verifierTaskCreatedAt ?? input.now,
    inputRevision: input.producerTask.inputRevision,
    question: {
      text: `Independently replay owner-approved finding ${findingId} inside the exact approved target using only owner-approved read-only requests. First perform the single owner-approved baseline observation, then call p2o_verify with findingId "${findingId}", then publish one bounded H1 packet that references the verifier-owned receipts. Report the controller outcome honestly; never author exploit, impact or post-exploitation claims.`,
      ifTrue: 'The fresh verifier environment reproduces the owner-approved violation observable while the approved negative control still passes.',
      ifFalse: 'The fresh verifier environment shows only the owner-approved safe observable, so the bounded claim does not reproduce.',
    },
    scope: {
      authorizationRef: input.producerTask.scope.authorizationRef,
      targetIds: [...input.producerTask.scope.targetIds],
      actor: { id: input.producerTask.scope.actor.id, privileges: ['read'] },
      boundary: `${input.producerTask.scope.boundary}; independent verifier replay of one owner-approved bounded differential only`,
      isolation: input.producerTask.scope.isolation,
      recovery: input.producerTask.scope.recovery,
      environmentId: `verifier-${input.producerTask.scope.environmentId}`.slice(0, 128),
      configurationDigest: input.producerTask.scope.configurationDigest,
      inputs: input.producerTask.scope.inputs.map(entry => ({ ...entry })),
    },
    skills: ['independent-verification'],
    allowedActions: ['read'],
    requiredCapabilities: ['http.request'],
    budgets: {
      deadlineAt: input.producerTask.budgets.deadlineAt,
      maxRequests: Math.max(REPLAY_STEPS + VERIFIER_OBSERVATIONS, Math.min(input.verifierBudget.maxRequests, input.run.budgets.maxRequests)),
      maxBytes: Math.min(REPLAY_RESPONSE_BYTES * (REPLAY_STEPS + VERIFIER_OBSERVATIONS), input.run.budgets.maxBytes),
      maxToolCalls: Math.max(REPLAY_STEPS + VERIFIER_OBSERVATIONS, Math.min(input.verifierBudget.maxToolCalls, input.run.budgets.maxToolCalls)),
      maxTokens: Math.min(input.verifierBudget.maxTokens, input.run.budgets.maxTokens),
      maxCostUsd: Math.min(input.verifierBudget.maxCostUsd, input.run.budgets.maxCostUsd),
      maxAttempts: 1,
    },
    requestedRuntime: { ...input.producerTask.requestedRuntime, selection: { ...input.producerTask.requestedRuntime.selection } },
    workspace: `${input.workspaceRoot}/${verifierTaskId}`,
    lifecycleState: 'queued',
    packetState: 'draft',
  };

  const verifierCheck: ObservationCheck = {
    checkId: verifierCheckId,
    taskId: verifierTaskId,
    observationId: verifierObservationId,
    tool: 'http.request',
    input: { ...(baselineCandidate.input as Record<string, unknown>) } as ObservationCheck['input'],
    kind: 'observation',
    classification: 'independently-observed',
    summary: 'Independent verifier baseline observation of one owner-approved read-only request; re-establishes the expected fixture state before the bounded replay',
    ...(baselineCandidate.expectation === undefined ? {} : { expectation: { ...baselineCandidate.expectation } }),
  };

  const test = (purpose: 'negative-control' | 'reproduction') => ({ purpose, invariant: claim, originalPolicy: true, targetId: input.targetId });
  const enrichedChecks = input.checks.map(check => {
    if (check.checkId === control.checkId) return { ...check, test: test('negative-control') } satisfies ObservationCheck;
    if (check.checkId === reproduction.checkId) return { ...check, test: test('reproduction') } satisfies ObservationCheck;
    return { ...check };
  });

  const finding: FindingPlan = {
    findingId,
    taskId: input.producerTask.taskId,
    title: `Bounded differential reproduction of the owner-approved observation: ${reproduction.summary.slice(0, 380)}`,
    claim,
    state: 'reproduced',
    classification: 'independently-observed',
    limitations: [
      `Bounded to the exact owner-approved read-only requests on target ${input.targetId} under the owner-approved account; no other path, method, account or state change was approved or exercised.`,
      'The producing attempt ran the owner-approved reproduction and negative control; promotion or rejection is decided only by the independent verifier replay in a fresh verifier attempt and environment.',
      'The verifier attempt/session is separate; targetReset=false. Passing read-only controls qualify only the current observable baseline, not a clean stateful target.',
      'No exploitability, impact, privilege escalation or post-exploitation capability is claimed; unsupported claims remain unresolved.',
    ],
  };

  return {
    program: {
      claim, approvedTarget, baselineCandidate, control, reproduction,
      baselineRequest, controlRequest, reproductionRequest, baseline, safe, violation,
      findingId, verifierTaskId, verifierObservationId, verifierCheckId,
      recipe, verification, verifierTask, verifierCheck, enrichedChecks, finding,
      replay: {
        plan: verification,
        verifierObservationId,
        verifierObservationInput: structuredClone(verifierCheck.input),
        origin: parsedControl.origin,
        approvedUrls: [baselineRequest.url, controlRequest.url, reproductionRequest.url],
        supportedClass: FIRST_USE_REPLAY_CLASS,
      },
    },
  };
}

/**
 * Controller derivation used at plan-approval time: no candidate, vault or capability is required, so the
 * pre-authorized verifier task identity can be placed in the owner grant. It grants nothing by itself and
 * never produces a finding.
 */
export function deriveFirstUseVerificationPlan(input: FirstUseVerificationPlanningInput): FirstUseVerificationPlanning {
  const approved = ownerApprovedClaimForChecks(input.checks);
  if (!approved.ok) return planningRefuse(approved.reason);
  const planned = planFirstUseVerificationProgram(input, approved.claim, firstUseFindingId(input.producerTask.taskId, approved.claim));
  if ('reason' in planned) return planningRefuse(planned.reason);
  const program = planned.program;
  const draft: FirstUseVerificationDraft = {
    finding: program.finding,
    verification: program.verification,
    verifierTask: program.verifierTask,
    verifierCheck: program.verifierCheck,
    enrichedChecks: program.enrichedChecks,
    replay: program.replay,
  };
  return { supported: true, draft };
}

export function synthesizeFirstUseVerification(input: FirstUseVerificationInput): FirstUseVerificationSynthesis {
  const { candidate, vault, verificationPolicy, policyContext } = input;
  if (!candidate || !vault) return refuse('a concrete evidence-bound candidate and collector vault are required; a task question is not a finding');
  const concrete = candidate.finding;
  if (!concrete.claim.trim() || concrete.claim.trim().endsWith('?') || concrete.claim === input.producerTask.question.text) return refuse('candidate must assert a concrete claim, not a task question');
  if (candidate.requiresTargetReset !== false) return refuse('reset-dependent claims require qualified target reconstruction; a new verifier attempt is not a target reset');
  if (concrete.runId !== input.run.runId || concrete.taskId !== input.producerTask.taskId || concrete.state !== 'reproduced') return refuse('candidate is not a reproduced finding from this producer/run');
  try {
    const review = validateFinding(vault, concrete, { reviewerId: 'first-use-controller', now: input.now });
    if (review.status !== 'accepted') return refuse(`candidate receipts do not demonstrate claim: ${review.issues.map(i => i.code).join(', ')}`);
    if (!verificationPolicy || !policyContext) return refuse('controller-authorized verification policy/context required');
    assertScopedVerificationPolicy(verificationPolicy);
    if (verificationPolicy.runId !== input.run.runId || policyContext.runId !== input.run.runId || policyContext.taskId !== input.producerTask.taskId) return refuse('verification policy/context differs from producer run/task');
  } catch (error) { return refuse(`candidate/policy refused: ${error instanceof Error ? error.message : 'integrity failure'}`); }

  const planned = planFirstUseVerificationProgram(input, concrete.claim, concrete.findingId);
  if ('reason' in planned) return refuse(planned.reason);
  const program = planned.program;

  try {
    for (const [check, ids] of [[program.baselineCandidate, candidate.baselineEvidenceIds], [program.control, concrete.negativeControlEvidenceIds], [program.reproduction, concrete.evidenceIds]] as const) {
      verificationPolicy.assertRequest(policyContext, input.targetId, approvedRequestOf(check) as ApprovedRequest);
      const receipt = ids.map(id => vault.get(id)).find(e => e?.taskId === concrete.taskId
        && e.attemptId === policyContext.attemptId && e.metadata?.observationId === check.observationId
        && e.kind === check.kind && e.provenance.originalEnvironment && e.provenance.environmentId === input.producerTask.scope.environmentId
        && e.provenance.configurationDigest === input.producerTask.scope.configurationDigest
        && digestJson([...e.provenance.inputDigests].sort()) === digestJson(input.producerTask.scope.inputs.map(i => i.digest).sort())
        && vault.inspect(e.evidenceId)?.collector.scopeDigest === verificationPolicy.scopeDigest
        && vault.inspect(e.evidenceId)?.collector.authorizationDigest === digestJson(input.producerTask.scope.authorizationRef)
        && vault.inspect(e.evidenceId)?.collector.operationInputDigest === digestJson(check.input));
      if (!receipt || (check !== program.baselineCandidate && !receiptSupportsClaim(receipt, concrete.claim))) return refuse(`candidate lacks the exact collector receipt for approved ${check.kind} ${check.checkId}`);
      const data = JSON.parse(vault.read(receipt.evidenceId).toString('utf8')) as { kind?: string; status?: number; body?: string };
      const prediction = predictionOf(check);
      if (typeof prediction === 'string' || data.kind !== 'http' || data.status !== prediction.status
        || (prediction.bodyIncludes !== undefined && !data.body?.includes(prediction.bodyIncludes))) return refuse(`approved ${check.kind} evidence does not establish its prediction`);
      const opposite = check === program.reproduction ? program.safe : check === program.control ? program.violation : undefined;
      if (opposite && data.status === opposite.status && (opposite.bodyIncludes === undefined || data.body?.includes(opposite.bodyIncludes))) return refuse(`approved ${check.kind} evidence matches both predictions and is inconclusive`);
    }
  } catch (error) { return refuse(`scoped candidate refused: ${error instanceof Error ? error.message : 'integrity failure'}`); }

  const leg: FirstUseVerificationLeg = {
    candidate: structuredClone(concrete),
    baselineEvidenceIds: [...candidate.baselineEvidenceIds],
    // The post-admission plan carries the exact per-claim receipts selected from the admitted packet; the
    // report layer must never fall back to the packet's broad attribution for this finding.
    finding: {
      ...program.finding,
      evidenceIds: [...concrete.evidenceIds],
      negativeControlEvidenceIds: [...concrete.negativeControlEvidenceIds],
    },
    verification: program.verification,
    verifierTask: program.verifierTask,
    verifierCheck: program.verifierCheck,
    enrichedChecks: program.enrichedChecks,
    replay: program.replay,
  };
  return { supported: true, leg };
}
