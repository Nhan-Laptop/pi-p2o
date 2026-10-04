import {
  attemptSchema, contractIssue, digestJson, findingSchema, makeSchema, rules as r, taskSchema, validateScope,
  type AttemptRecord, type Authorization, type ContractIssue, type FindingRecord, type TaskManifest,
} from '../contracts/index.js';
import type { ToolBroker, HttpInput, ToolResult } from '../tools/types.js';
import type { ToolContext } from '../policy/types.js';
import { admitToolResult } from './broker.js';
import { checkId, checkTime, digestRule, EvidenceError, freeze, idRule, normalized, requireEvidence, sameSet } from './common.js';
import { validateFinding, type FindingReview } from './verification.js';
import type { EvidenceVault } from './vault.js';

import { assertScopedVerificationPolicy, type ScopedVerificationPolicy } from '../application/first-use-verification/policy.js';
export interface HttpPrediction { status: number; bodyIncludes?: string }
export interface LocalReplayRecipe {
  recipeId: string; fixtureId: string; targetId: string; invariant: string; inputDigests: string[];
  baseline: { input: HttpInput; expected: HttpPrediction };
  negativeControl: { input: HttpInput; expected: HttpPrediction };
  probe: { input: HttpInput; violation: HttpPrediction; safe: HttpPrediction };
}
export interface ReplayRequest {
  /** Controller recipe identity; prepare must qualify exactly this approved recipe. */
  recipeDigest: string;
  replayId: string; fixtureId: string; verifierId: string; task: TaskManifest; attempt: AttemptRecord;
  authorization: Authorization; deadlineAt: string; signal: AbortSignal;
}
/** Supplied by a qualified, trusted supervisor broker, never by a worker script or subprocess path. */
export interface CleanReplaySession {
  /** Controller capability derived from the actual verifier broker scope. Omission fails closed. */
  verificationPolicy?: ScopedVerificationPolicy;
  environmentReceiptId: string;
  context: ToolContext;
  artifactRootId: string;
  httpTool: { name: 'http.request'; version: string; implementationDigest: string };
  broker: ToolBroker;
  /** Must preserve a collector runtime receipt with metadata.terminationConfirmed=true. */
  close(signal: AbortSignal): Promise<{ receiptEvidenceId: string }>;
}
export interface CleanReplayBroker { prepare(request: ReplayRequest): Promise<CleanReplaySession> }
export interface ReplayOptions {
  vault: EvidenceVault; broker: CleanReplayBroker; finding: unknown; recipe: LocalReplayRecipe;
  replayId: string; verifierId: string; verifierTask: TaskManifest; verifierAttempt: AttemptRecord;
  authorization: Authorization; clock?: () => string; maxMs?: number; signal?: AbortSignal;
}
export interface ReplayOutcome {
  readonly status: 'accepted' | 'rejected' | 'returned-for-evidence';
  readonly review: FindingReview;
  readonly evidenceIds: readonly string[];
  readonly issues: readonly ContractIssue[];
}
const prediction = r.object({ status: r.number(true, 100, 599), bodyIncludes: r.optional(r.string({ maxLength: 512 })) });
// Intentionally only fixed read-only HTTP checks. No command/script/module/eval, body, headers or mutation.
const httpInput = r.object({ url: r.string({ maxLength: 4096 }), accountId: idRule, method: r.optional(r.enum(['GET', 'HEAD'])), action: r.optional(r.literal('read')), maxResponseBytes: r.optional(r.number(true, 1, 65_536)), maxRedirects: r.optional(r.literal(0)) });
const recipeSchema = makeSchema<LocalReplayRecipe>('local-replay-recipe', r.object({
  recipeId: idRule, fixtureId: idRule, targetId: idRule, invariant: r.string(), inputDigests: r.array(digestRule, 1, true),
  baseline: r.object({ input: httpInput, expected: prediction }), negativeControl: r.object({ input: httpInput, expected: prediction }),
  probe: r.object({ input: httpInput, violation: prediction, safe: prediction }),
}));
function matches(data: unknown, p: HttpPrediction): boolean {
  if (!data || typeof data !== 'object') return false;
  const http = data as { kind?: unknown; status?: unknown; body?: unknown };
  return http.kind === 'http' && http.status === p.status && (p.bodyIncludes === undefined || (typeof http.body === 'string' && http.body.includes(p.bodyIncludes)));
}
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('Replay deadline/cancellation');
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { abort = () => reject(new Error('Replay deadline/cancellation')); signal.addEventListener('abort', abort, { once: true }); })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}
/** The only execution path is the supplied qualified broker's fixed named tool API. */
export async function replayFinding(options: ReplayOptions): Promise<ReplayOutcome> {
  const clock = options.clock ?? (() => new Date().toISOString());
  const now = clock(); checkTime(now); checkId(options.replayId); checkId(options.verifierId);
  const initial = validateFinding(options.vault, options.finding, { reviewerId: options.verifierId, now });
  if (initial.status !== 'accepted' || !initial.finding) return freeze({ status: 'returned-for-evidence', review: initial, evidenceIds: [], issues: initial.issues });
  const finding = findingSchema.parse(initial.finding);
  if (finding.state === 'supported-static') return freeze({ status: 'accepted', review: initial, evidenceIds: [], issues: [contractIssue('static-only', '$/state', 'Source-only classification was retained without execution', 'Dynamic replay remains unperformed.')] });
  const issues: ContractIssue[] = [], collected: string[] = [];
  const add = (code: string, message: string, question: string) => issues.push(contractIssue(code, '$/replay', message, question));
  let session: CleanReplaySession | undefined, next: FindingRecord = finding;
  const controller = new AbortController(), cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observation: 'violation' | 'safe' | 'inconclusive' = 'inconclusive';
  try {
    requireEvidence(finding.state === 'reproduced', 'initial-reproduction', 'Independent replay requires an already receipt-backed reproduced finding');
    const task = taskSchema.parse(options.verifierTask), attempt = attemptSchema.parse(options.verifierAttempt), recipe = recipeSchema.parse(options.recipe);
    requireEvidence(task.runId === finding.runId && attempt.runId === finding.runId && attempt.taskId === task.taskId && attempt.ownerId === options.verifierId && options.verifierId !== finding.producerId && attempt.attemptId !== options.vault.get(finding.evidenceIds[0])?.attemptId, 'verifier-identity', 'Verifier must use a distinct authorized identity/attempt');
    const scopeIssues = validateScope(task.scope, options.authorization, now, ['read']);
    requireEvidence(['running', 'waiting'].includes(attempt.lifecycleState) && !scopeIssues.length && task.allowedActions.includes('read'), 'replay-scope', `Verifier task must have an active explicit read-only authorization${scopeIssues.length ? `: ${scopeIssues.map(i => `${i.code} ${i.path}: ${i.message}`).join(', ')}` : ''}`);
    requireEvidence(normalized(recipe.invariant) === normalized(finding.claim) && sameSet(recipe.inputDigests, task.scope.inputs.map(i => i.digest)) && task.scope.targetIds.includes(recipe.targetId), 'replay-input', 'Recipe must preserve the exact bounded claim, target and input identities');
    requireEvidence(digestJson(recipe.probe.violation) !== digestJson(recipe.probe.safe), 'replay-predictions', 'Replay predictions must be distinguishable');
    const target = options.authorization.targets.find(t => t.id === recipe.targetId);
    requireEvidence(target && ['lab', 'web'].includes(target.kind), 'scoped-target', 'Replay requires an explicitly authorized lab/web target');
    const approvedTarget = new URL(target.locator);
    const prefix = approvedTarget.pathname.replace(/\/+$/u, '');
    for (const step of [recipe.baseline, recipe.negativeControl, recipe.probe]) {
      const url = new URL(step.input.url);
      requireEvidence(['http:', 'https:'].includes(url.protocol) && url.origin === approvedTarget.origin && !url.username && !url.password && !url.hash
        && (!prefix || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)), 'scoped-target', 'Replay URLs must remain inside the owner-approved origin/path');
    }
    const ms = Math.min(checkTime(options.authorization.expiresAt), checkTime(task.budgets.deadlineAt), checkTime(attempt.deadlineAt)) - checkTime(now);
    requireEvidence(ms > 0 && Number.isSafeInteger(options.maxMs ?? 10_000) && (options.maxMs ?? 10_000) > 0 && (options.maxMs ?? 10_000) <= 60_000, 'replay-deadline', 'Replay must fit a bounded absolute deadline');
    const duration = Math.min(ms, options.maxMs ?? 10_000), deadlineAt = new Date(checkTime(now) + duration).toISOString();
    timer = setTimeout(cancel, duration);
    const request: ReplayRequest = { recipeDigest: digestJson(recipe), replayId: options.replayId, fixtureId: recipe.fixtureId, verifierId: options.verifierId, task, attempt, authorization: options.authorization, deadlineAt, signal: controller.signal };
    // If prepare resolves after timeout, still request bounded cleanup; never infer successful termination.
    const preparing = options.broker.prepare(request);
    try { session = await bounded(preparing, controller.signal); }
    catch (e) {
      void preparing.then(async late => { const cleanup = AbortSignal.timeout(1000); await late.close(cleanup); }).catch(() => {});
      throw e;
    }
    const environment = options.vault.get(session.environmentReceiptId), record = options.vault.inspect(session.environmentReceiptId);
    requireEvidence(environment && record && environment.kind === 'runtime' && record.collector.role === 'verifier' && environment.provenance.collectorId === options.verifierId && environment.attemptId === attempt.attemptId && environment.taskId === task.taskId && environment.runId === finding.runId && environment.metadata?.independentSession === true && environment.metadata?.targetReset === false && typeof environment.metadata?.qualification === 'string' && environment.provenance.originalEnvironment && sameSet(environment.provenance.inputDigests, recipe.inputDigests) && environment.provenance.configurationDigest === task.scope.configurationDigest && environment.provenance.environmentId === task.scope.environmentId, 'clean-environment', 'Independent verifier session must be authenticated; a new attempt is not a qualified target reset');
    requireEvidence(finding.evidenceIds.every(id => options.vault.get(id)?.provenance.environmentId !== environment.provenance.environmentId), 'clean-environment', 'Verifier environment must be distinct from the producing environment');
    requireEvidence(environment.metadata?.recipeDigest === digestJson(recipe), 'replay-recipe-binding', 'Environment qualification must bind the exact controller-approved recipe, including accounts, caps and predictions');
    requireEvidence(session.context.runId === finding.runId && session.context.taskId === task.taskId && session.context.attemptId === attempt.attemptId, 'broker-context', 'Broker grant does not match verifier execution ownership');
    collected.push(environment.evidenceId);
    requireEvidence(session.verificationPolicy, 'verification-policy', 'Explicit controller-authorized scoped verification policy is required');
    assertScopedVerificationPolicy(session.verificationPolicy);
    requireEvidence(session.verificationPolicy.runId === finding.runId && session.verificationPolicy.scopeDigest === record.collector.scopeDigest, 'verification-policy', 'Verification policy must match the collected broker scope');
    session.verificationPolicy.assertVerifier(session.context);
    for (const step of [recipe.baseline, recipe.negativeControl, recipe.probe]) session.verificationPolicy.assertRequest(session.context, recipe.targetId, step.input);
    const handle = options.vault.issueCollector({ collectorId: options.verifierId, role: 'verifier', runId: finding.runId, taskId: task.taskId, attemptId: attempt.attemptId, authorizationRef: task.scope.authorizationRef, environmentId: environment.provenance.environmentId, configurationDigest: task.scope.configurationDigest,
      scopeDigest: record.collector.scopeDigest, inputDigests: recipe.inputDigests, toolGrantId: session.context.grantId, tool: session.httpTool, artifactRootIds: [session.artifactRootId], allowedKinds: ['baseline', 'negative-control', 'reproduction'], allowedClassifications: ['independently-observed'], validFrom: attempt.createdAt, expiresAt: deadlineAt, originalEnvironment: true, modifications: [] });
    const observe = async (name: 'baseline' | 'negative-control' | 'reproduction', input: HttpInput, classify: (data: unknown) => 'passed' | 'failed' | 'inconclusive'): Promise<'passed' | 'failed' | 'inconclusive'> => {
      requireEvidence(checkTime(clock()) < checkTime(deadlineAt) && !controller.signal.aborted, 'replay-deadline', 'Replay is expired or cancelled');
      const operation = { ...input, method: input.method ?? 'GET', action: 'read' as const, maxResponseBytes: input.maxResponseBytes ?? 65_536, maxRedirects: 0 };
      session!.verificationPolicy!.assertRequest(session!.context, recipe.targetId, operation);
      const result: ToolResult = await bounded(session!.broker.execute({ context: session!.context, tool: 'http.request', input: operation, signal: controller.signal }), controller.signal);
      const raw = options.vault.readCollected(handle, { rootId: session!.artifactRootId, path: result.artifact.path, expectedDigest: result.artifact.sha256, expectedBytes: result.artifact.bytes, mediaType: result.artifact.mediaType });
      // Compare only redacted, collected bytes, never execute/import/interpret worker-authored scripts.
      const data = JSON.parse(options.vault.redactor.artifact(raw, 'application/json').toString('utf8'));
      const outcome = classify(data), evidenceId = `${options.replayId}.${name}`;
      const admission = admitToolResult(options.vault, handle, { result, operationInput: operation, artifactRootId: session!.artifactRootId,
        evidence: { evidenceId, idempotencyKey: evidenceId, kind: name, classification: 'independently-observed', summary: `${recipe.recipeId}: ${name} ${outcome}`, test: { purpose: name, outcome, successes: outcome === 'passed' ? 1 : 0, attempts: 1, invariant: finding.claim, originalPolicy: true, targetId: recipe.targetId }, metadata: { claimDigest: digestJson(finding.claim), recipeId: recipe.recipeId } } });
      collected.push(admission.receipt.evidenceId);
      return outcome;
    };
    const baseline = await observe('baseline', recipe.baseline.input, data => matches(data, recipe.baseline.expected) ? 'passed' : 'failed');
    const negative = await observe('negative-control', recipe.negativeControl.input, data => matches(data, recipe.negativeControl.expected) ? 'passed' : 'failed');
    if (baseline !== 'passed' || negative !== 'passed') add('replay-controls', 'Known-good baseline or negative control failed', 'Repair/establish the original-policy controls before accepting the claim.');
    else {
      const result = await observe('reproduction', recipe.probe.input, data => {
        const violated = matches(data, recipe.probe.violation), safe = matches(data, recipe.probe.safe);
        return violated && !safe ? 'passed' : safe && !violated ? 'failed' : 'inconclusive';
      });
      observation = result === 'passed' ? 'violation' : result === 'failed' ? 'safe' : 'inconclusive';
      if (observation === 'inconclusive') add('replay-inconclusive', 'Neither exclusive prediction was established', 'Narrow the observation/prerequisites; retain the finding as unresolved.');
    }
  } catch (e) {
    if (e instanceof EvidenceError) add(e.code, e.message, 'Resolve this bounded verifier prerequisite without widening scope or executing worker code.');
    else add('replay-blocked', e instanceof Error ? options.vault.redactor.text(e.message).slice(0, 512) : 'Replay failed safely', 'Resolve this bounded verifier prerequisite without widening scope or executing worker code.');
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    if (session) {
      try {
        const cleanupSignal = AbortSignal.timeout(1000);
        const closed = await bounded(session.close(cleanupSignal), cleanupSignal);
        const e = options.vault.get(closed.receiptEvidenceId), record = options.vault.inspect(closed.receiptEvidenceId);
        requireEvidence(e && record?.collector.role === 'verifier' && e.kind === 'runtime' && e.provenance.collectorId === options.verifierId && e.attemptId === options.verifierAttempt.attemptId && e.provenance.environmentId === options.verifierTask.scope.environmentId && e.metadata?.terminationConfirmed === true, 'replay-cleanup', 'Replay environment termination is not receipt-backed');
        collected.push(e.evidenceId);
      } catch { add('replay-cleanup', 'Clean-environment termination could not be confirmed', 'Reconcile the environment before accepting independent validation.'); }
    }
  }
  if (issues.length) next = { ...finding, state: 'unresolved', classification: 'unresolved', evidenceIds: [...new Set([...finding.evidenceIds, ...collected])], limitations: [...finding.limitations, ...issues.map(i => i.message)] };
  else if (observation === 'safe') next = { ...finding, state: 'rejected', limitations: [...finding.limitations, 'Independent original-policy local replay did not reproduce the claim; bounded to the tested fixture.'], evidenceIds: [...new Set([...finding.evidenceIds, ...collected])] };
  else next = { ...finding, state: 'independently-validated', classification: 'independently-observed', verifier: { identity: options.verifierId, attemptId: options.verifierAttempt.attemptId, environmentId: options.verifierTask.scope.environmentId, evidenceIds: collected } };
  const review = validateFinding(options.vault, next, { reviewerId: options.verifierId, now: clock() });
  return freeze({ status: issues.length || review.status !== 'accepted' ? 'returned-for-evidence' : observation === 'safe' ? 'rejected' : 'accepted', review, evidenceIds: collected, issues: [...issues, ...review.issues] });
}
