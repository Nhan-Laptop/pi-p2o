/**
 * The single human entrypoint `/p2o`.
 *
 * Grammar (see README):
 *   /p2o --target <local-dir|github-https-repo|http(s)-URL> [--purpose "..."] [--depth quick|standard|deep]
 *        [--plan-only] [--budget <USD>] [--concurrency <N>]
 *   /p2o status|stop|resume|report [runId]
 *   /p2o approve <planId>
 *   /p2o                       help + current run
 *
 * Authority rules:
 *   * The target port's prepare/plan must make zero target I/O, including local source reads/stat,
 *     clone/fetch and network requests. Receipt checks below validate the port contract, not live I/O.
 *   * `start`/`approve` are called only after `ctx.ui.confirm` for the exact scope, actions and spend. The
 *     confirmation mints a non-serializable, single-use capability bound to the run/scope/plan digests;
 *     the port consumes it and mints the exact owner approval artifact itself. No tool can reach this module.
 *   * `--plan-only` never starts and never sends a target request.
 */
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { boundedOutput, publicError, publicValue, safeText } from './presentation.js';
import { InterfaceController } from './controller.js';
import { parseP2OArgs, type P2OCommand } from './argv.js';
import { SessionRunRegistry } from './session-state.js';
import { InterfaceError } from './types.js';
import { humanConfirmationRef, issueHumanConfirmationCapability } from './human-approval.js';
import { classifyTargetSyntax } from './targets.js';
import type {
  EntryHumanApproval, EntryPlan, EntryReadPlan, EntryRun, EntryTarget, EntryPreparation, TargetEntryPort,
} from './target-entry.js';
import { ENTRY_PLAN_STEP_BOUNDS } from './target-entry.js';
import { onboardingScopeFor, type OnboardingHandler, type OnboardingReady, OnboardingError } from '../application/onboarding/index.js';
import { assertOwnerPreparation, onboardCommandTarget } from './onboarding.js';

export interface P2OCommandHost {
  controller: InterfaceController;
  registry: SessionRunRegistry;
  /** Persist non-context session state. Best-effort; absent in plain harnesses. */
  appendEntry?: (customType: string, data?: unknown) => void;
  /** Emit a user-visible transcript message (pi.sendMessage). */
  emit?: (message: { customType: string; content: string; display: true; details?: unknown }) => void;
  /**
   * Host session model-author seam for the planning step. The Pi extension binds its own model through
   * this hook; the value is opaque to the interface and never authority or confirmation.
   */
  planAuthorFor?: (ctx: ExtensionCommandContext) => unknown;
  /** Human-only onboarding precedes lazy backend creation and any model planning. */
  onboardingFor?: OnboardingHandler;
}

interface CommandOutcome { text: string; details: unknown }

const MAX_CONFIRM_BYTES = 12_000;

export function p2oHelp(currentRun?: string): string {
  const lines = [
    'p2o — one command for authorized, scoped assessments',
    '',
    '  /p2o --target <local-dir|github-https-repo|http(s)-URL>', 
    '       [flags] [--purpose "..."] [--depth quick|standard|deep] [--plan-only]',
    '       [--budget <USD>] [--concurrency <N>] [--deadline <minutes>]',
    '       [--profile conservative|wide|ceiling] [--basis <owner|written-permission|published-program|public-source-review>]',
    '       [--repo-scripts] [--state-changes] [--full-rights] [--advanced]',
    '  /p2o status|stop|resume|report [runId]',
    '  /p2o approve <planId>',
    '  /p2o                                  this help',
    '',
    'A target is the only required input. One consent dialog then shows the exact scope, authorization',
    'basis, separate rights and every limit being consented to; the rest is derived from --profile.',
    'Read/static is the default. Repository scripts and state changes stay OFF unless this invocation',
    'explicitly requests them (--repo-scripts, --state-changes, or --full-rights for a target you own),',
    'and they are always displayed in that dialog. --advanced asks every question separately instead.',
    'Limits are always finite and visible: --profile wide (default) keeps a real spend cap and deadline',
    'with the remaining ceilings at the validated maximum; --profile ceiling uses the validated maxima',
    'for every field. An unbounded cap would not be a guard, so it does not exist as an option.',
    'Saved consent is reused only within its exact scope, rights, budget and deadline; flags request',
    'review of expansions, never grant authority. The model plan still needs exact digest approval.',
    'Planning may incur explicitly selected assessment-model charges (including --plan-only); phase budget',
    'admission happens first. Insufficient consent returns partial/extension-required, never an increase.',
    'No target I/O during preparation/planning; nothing launches until you confirm the resulting plan.',
    'runId may be omitted only when this session has one unambiguous current run.',
  ];
  if (currentRun) lines.push('', `current run: ${safeText(currentRun, 160)}`);
  return lines.join('\n');
}

/** Strip the duplicated code prefix `InterfaceError.message` already carries. */
export function failureMessage(error: unknown): string {
  if (error instanceof InterfaceError || error instanceof OnboardingError) return safeText(error.message, 1024);
  return publicError(error).message;
}

/**
 * Build the approval value the entry port accepts. The non-serializable `authority` is minted here,
 * inside the human command handler, only after `ctx.ui.confirm` approved the exact sealed plan; the port
 * consumes it once and mints the owner approval artifact from it. `approvedAt`/`approvalRef` come from
 * that capability, so receipts and the minted artifact agree.
 */
function humanApproval(preparation: EntryPreparation, plan: EntryPlan): EntryHumanApproval {
  const capability = issueHumanConfirmationCapability({
    runId: preparation.runId, scopeDigest: preparation.scopeDigest, planDigest: plan.digest,
  });
  const { approvalRef, approvedAt } = humanConfirmationRef(capability);
  return {
    channel: 'human-command',
    approvalRef,
    approvedAt,
    scopeDigest: preparation.scopeDigest,
    planDigest: plan.digest,
    authority: capability,
  };
}

function contract(detail: string): InterfaceError {
  return new InterfaceError('ENTRY_CONTRACT_VIOLATION', detail);
}

function assertPreparation(preparation: EntryPreparation, expected: EntryTarget): void {
  if (!preparation || typeof preparation !== 'object') throw contract('prepare() returned no preparation');
  if (preparation.requiresHumanApproval !== true) throw contract('prepare() did not require human approval');
  if (preparation.targetRequests !== 0) throw contract('prepare() issued target requests; preparation must not touch the target');
  if (!preparation.runId || !preparation.scopeDigest || !Array.isArray(preparation.actions)) {
    throw contract('prepare() did not return runId, scopeDigest and actions');
  }
  if (preparation.target?.kind !== expected.kind) throw contract('prepare() returned a different target kind');
}

function assertPlan(plan: EntryPlan, preparation: EntryPreparation): void {
  if (!plan || typeof plan !== 'object') throw contract('plan() returned no plan');
  if (plan.targetRequests !== 0) throw contract('plan() issued target requests; planning must not touch the target');
  if (!plan.planId || !/^[a-f0-9]{64}$/.test(plan.digest) || !Array.isArray(plan.steps) ||
    plan.steps.length > ENTRY_PLAN_STEP_BOUNDS.maxSteps ||
    plan.steps.some(step => typeof step !== 'string' || step.length > ENTRY_PLAN_STEP_BOUNDS.maxStepChars)) {
    throw contract(`plan() must return 1..${ENTRY_PLAN_STEP_BOUNDS.maxSteps} steps of at most ${ENTRY_PLAN_STEP_BOUNDS.maxStepChars} characters each and the exact SHA-256 digest`);
  }
  if (plan.runId !== preparation.runId) throw contract('plan() returned a different runId than prepare()');
}

function assertRun(run: EntryRun, expectedRunId: string): void {
  if (!run || typeof run !== 'object' || run.runId !== expectedRunId) {
    throw contract(`start/resume returned run "${safeText(run?.runId, 80) || 'none'}" instead of "${safeText(expectedRunId, 80)}"`);
  }
  if (!run.state) throw contract('the run result did not include an observed state; launch is not a verified success');
}

function describePreparation(preparation: EntryPreparation, plan?: EntryPlan, owner?: OnboardingReady): string {
  const spend = preparation.spend;
  const lines = [
    `target:    ${safeText(preparation.target.kind, 32)} ${safeText(preparation.target.locator, 4096)}`,
    ...(preparation.target.revision ? [`revision:  ${safeText(preparation.target.revision, 120)}`] : []),
    `mode:      ${preparation.mode}`,
    `scope:     ${safeText(preparation.scopeDigest, 128)}`,
    `actions:   ${preparation.actions.slice(0, 24).map(action => safeText(action, 64)).join(', ') || '(none)'}`,
    `spend:     up to $${spend.maxCostUsd}, ${spend.maxRequests} requests, ${spend.maxTokens} tokens, ${spend.maxToolCalls} tool calls, ${spend.maxAttempts} attempts`,
    `workers:   concurrency ${preparation.concurrency}`,
    ...(owner ? [`deadline:  ${new Date(owner.effectiveLimits.deadlineMs).toISOString()} (absolute owner deadline)`] : []),
    ...(plan ? [`plan:      ${safeText(plan.planId, 128)} (digest ${safeText(plan.digest, 128)}), ${plan.steps.length} steps`] : []),
    ...(plan ? [`steps:     ${plan.steps.slice(0, ENTRY_PLAN_STEP_BOUNDS.maxSteps).map(step => safeText(step, ENTRY_PLAN_STEP_BOUNDS.maxStepChars)).join(' | ')}`] : []),
    ...(preparation.warnings.length ? [`warnings:  ${preparation.warnings.slice(0, 8).map(warning => safeText(warning, 200)).join(' | ')}`] : []),
    'preparation and planning made no target request.',
  ];
  return lines.join('\n');
}

async function requireConfirmation(ctx: ExtensionCommandContext, title: string, message: string): Promise<void> {
  if (ctx.signal?.aborted) throw new InterfaceError('CANCELLED', 'confirmation cancelled; no worker was started');
  if (!ctx.hasUI || typeof ctx.ui?.confirm !== 'function') {
    throw new InterfaceError('HUMAN_CONFIRMATION_REQUIRED',
      'this session cannot show a confirmation dialog; re-run with --plan-only, then approve interactively with /p2o approve <planId>');
  }
  const approved = await ctx.ui.confirm(title, safeText(message, MAX_CONFIRM_BYTES), ctx.signal ? { signal: ctx.signal } : undefined);
  if (ctx.signal?.aborted) throw new InterfaceError('CANCELLED', 'confirmation cancelled; no worker was started');
  if (approved !== true) throw new InterfaceError('NOT_APPROVED', 'you did not approve this run; no target test and no worker was started');
}

async function entryPort(host: P2OCommandHost, ctx: ExtensionCommandContext, onboarding?: OnboardingReady): Promise<TargetEntryPort> {
  const port = await host.controller.entryPort(ctx.cwd, host.planAuthorFor?.(ctx), onboarding);
  if (!port) {
    throw new InterfaceError('INTEGRATION_REQUIRED',
      'the target workflow is not wired into this composition; add TargetEntryPort under src/application/entry/** and expose it as backend.entry');
  }
  return port;
}

async function tryEntryPort(host: P2OCommandHost, ctx: ExtensionCommandContext): Promise<TargetEntryPort | undefined> {
  try { return await host.controller.entryPort(ctx.cwd, host.planAuthorFor?.(ctx)); }
  catch { return undefined; }
}

async function resolveRunId(host: P2OCommandHost, ctx: ExtensionCommandContext, explicit?: string): Promise<{ runId: string; source: 'explicit' | 'session' | 'entry-current' }> {
  if (explicit) return { runId: explicit, source: 'explicit' };
  if (host.registry.currentRunId) return { runId: host.registry.currentRunId, source: 'session' };
  const port = await tryEntryPort(host, ctx);
  if (port?.currentRun) {
    const current = await port.currentRun(ctx.signal);
    if (current && typeof current.runId === 'string' && current.runId) return { runId: current.runId, source: 'entry-current' };
  }
  throw new InterfaceError('RUN_ID_REQUIRED', 'no unambiguous current run in this session; pass a runId, for example /p2o status <runId>');
}

function recordRun(host: P2OCommandHost, runId: string, state?: string): SessionRunRegistry {
  const record = host.registry.rememberRun(runId, state);
  try { host.appendEntry?.('p2o_run', record); } catch { /* session persistence is best-effort; memory state is authoritative */ }
  return host.registry;
}

function recordPlan(host: P2OCommandHost, record: Parameters<SessionRunRegistry['rememberPlan']>[0]): void {
  host.registry.rememberPlan(record);
  try { host.appendEntry?.('p2o_plan', record); } catch { /* best-effort */ }
}

async function readPlan(host: P2OCommandHost, port: TargetEntryPort, planId: string, ctx: ExtensionCommandContext): Promise<EntryReadPlan> {
  if (port.readPlan) {
    const found = await port.readPlan(planId, ctx.signal);
    if (!found) throw new InterfaceError('PLAN_NOT_FOUND', `the target workflow does not know plan ${safeText(planId, 160)}`);
    assertPreparation(found.preparation, found.preparation.target);
    assertPlan(found.plan, found.preparation);
    return found;
  }
  const recorded = host.registry.plan(planId);
  if (!recorded) {
    throw new InterfaceError('PLAN_NOT_FOUND', `plan ${safeText(planId, 160)} is not known in this session and the target workflow exposes no plan reads`);
  }
  return { preparation: recorded.preparation, plan: recorded.plan };
}

async function startCommand(host: P2OCommandHost, command: Extract<P2OCommand, { verb: 'start' }>, ctx: ExtensionCommandContext): Promise<CommandOutcome> {
  const classified = classifyTargetSyntax(command.target);
  // One-dialog quick consent is the default: the target is the only required argument, and the dialog shows the
  // exact scope, authorization basis, separate rights and every limit that will be consented to.
  const owner = await onboardCommandTarget(ctx, classified, host.onboardingFor, command.budgetUsd, command.concurrency, {
    mode: command.advanced ? 'guided' : 'quick',
    ...(command.profile !== undefined ? { profile: command.profile } : {}),
    ...(command.basis !== undefined ? { basis: command.basis } : {}),
    permissions: { ...(command.repositoryScripts ? { repositoryScripts: true } : {}), ...(command.stateChanges ? { stateChanges: true } : {}) },
    limits: command.deadlineMinutes !== undefined ? { deadlineMs: Date.now() + command.deadlineMinutes * 60_000 } : {},
  });
  const target = onboardingScopeFor(classified, ctx.cwd).target;
  // Cost/data disclosure and human scope consent precede the first model-author or backend callback.
  if (typeof ctx.waitForIdle === 'function') await ctx.waitForIdle();
  const port = await entryPort(host, ctx, owner);
  const preparation = await port.prepare({
    target,
    ...(command.purpose !== undefined ? { purpose: command.purpose } : {}),
    depth: command.depth,
    planOnly: command.planOnly,
    budgetUsd: owner.effectiveLimits.maxCostUsd,
    concurrency: owner.effectiveLimits.concurrency,
  }, ctx.signal);
  assertPreparation(preparation, target);
  assertOwnerPreparation(owner, preparation, ctx.cwd);
  const plan = await port.plan({ preparation }, ctx.signal);
  assertPlan(plan, preparation);
  assertOwnerPreparation(owner, preparation, ctx.cwd);
  recordPlan(host, {
    planId: plan.planId, runId: preparation.runId, digest: plan.digest, scopeDigest: preparation.scopeDigest,
    createdAt: new Date().toISOString(), preparation, plan,
  });
  const summary = describePreparation(preparation, plan, owner);
  if (command.planOnly) {
    return {
      text: `Plan only — no target request was sent and no worker started.\n\n${summary}\n\nReview the scope and run:\n  /p2o approve ${safeText(plan.planId, 160)}\nNothing runs until you approve.`,
      details: { verb: 'start', planOnly: true, runId: preparation.runId, planId: plan.planId, scopeDigest: preparation.scopeDigest, planDigest: plan.digest, targetRequests: 0 },
    };
  }
  await requireConfirmation(ctx, `Approve p2o run ${safeText(preparation.runId, 160)}?`, summary);
  assertOwnerPreparation(owner, preparation, ctx.cwd);
  const approval = humanApproval(preparation, plan);
  const run = await port.start({ preparation, plan, approval }, ctx.signal);
  assertRun(run, preparation.runId);
  recordRun(host, run.runId, run.state);
  return {
    text: `Approved and admitted — run ${safeText(run.runId, 160)} (state ${safeText(run.state, 80)}).\n\n${summary}\n\nLaunch is not acceptance: read /p2o status ${safeText(run.runId, 160)} for the observed state.`,
    details: { verb: 'start', runId: run.runId, state: run.state, planId: plan.planId, approvalRef: approval.approvalRef, ...(run.approvalPath ? { approvalPath: run.approvalPath } : {}), targetRequests: 0 },
  };
}

async function approveCommand(host: P2OCommandHost, command: Extract<P2OCommand, { verb: 'approve' }>, ctx: ExtensionCommandContext): Promise<CommandOutcome> {
  const port = await entryPort(host, ctx);
  const found = await readPlan(host, port, command.planId, ctx);
  const owner = await onboardCommandTarget(ctx, found.preparation.target, host.onboardingFor,
    found.preparation.spend.maxCostUsd, found.preparation.concurrency, { mode: 'quick' });
  await entryPort(host, ctx, owner);
  assertOwnerPreparation(owner, found.preparation, ctx.cwd);
  const summary = describePreparation(found.preparation, found.plan, owner);
  await requireConfirmation(ctx, `Approve plan ${safeText(command.planId, 160)}?`, summary);
  assertOwnerPreparation(owner, found.preparation, ctx.cwd);
  const approval = humanApproval(found.preparation, found.plan);
  const receipt = await port.approve({ planId: command.planId, planDigest: found.plan.digest, approval }, ctx.signal);
  if (!receipt || receipt.planId !== command.planId || receipt.approved !== true) {
    throw contract('approve() did not confirm the exact plan');
  }
  if (!receipt.admittedOnce) throw new InterfaceError('ALREADY_APPROVED', `plan ${safeText(command.planId, 160)} was already admitted; nothing new was launched`);
  if (!receipt.run?.runId) throw contract('approve() did not report the admitted run');
  assertRun(receipt.run, found.plan.runId);
  recordRun(host, receipt.run.runId, receipt.run.state);
  return {
    text: `Approved plan ${safeText(command.planId, 160)} — run ${safeText(receipt.run.runId, 160)} admitted once (state ${safeText(receipt.run.state, 80)}).\n\n${summary}\n\nLaunch is not acceptance: read /p2o status ${safeText(receipt.run.runId, 160)} for the observed state.`,
    details: { verb: 'approve', planId: command.planId, runId: receipt.run.runId, admittedOnce: true, approvalRef: approval.approvalRef, ...(receipt.run.approvalPath ? { approvalPath: receipt.run.approvalPath } : {}) },
  };
}

async function lifecycleCommand(host: P2OCommandHost, command: Extract<P2OCommand, { verb: 'status' | 'stop' | 'report' }>, ctx: ExtensionCommandContext): Promise<CommandOutcome> {
  const { runId, source } = await resolveRunId(host, ctx, command.runId);
  if (command.verb === 'status' || command.verb === 'report') {
    const input = command.verb === 'status' ? { runId } : { runId, format: 'markdown' as const };
    const output = boundedOutput(await host.controller.execute(command.verb, input, ctx.cwd, ctx.signal));
    recordRun(host, runId);
    return { text: output.text, details: { verb: command.verb, runId, runSource: source, result: output.value } };
  }
  const port = await tryEntryPort(host, ctx);
  if (port?.stop) {
    const receipt = await port.stop(runId, 'user-requested /p2o stop');
    if (receipt.runId !== runId || !receipt.schedulingStopped || !receipt.terminationVerified || receipt.failures.length) {
      throw new InterfaceError('STOP_UNVERIFIED', 'runtime termination is unresolved; ownership/fences must be retained');
    }
    recordRun(host, runId);
    return { text: `stopped run ${safeText(runId, 160)} (verified termination)\n${JSON.stringify(publicValue(receipt), null, 2)}`, details: { verb: 'stop', runId, runSource: source, receipt: publicValue(receipt) } };
  }
  const output = boundedOutput(await host.controller.execute('stop', { runId, reason: 'user-requested /p2o stop' }, ctx.cwd, ctx.signal));
  recordRun(host, runId);
  return { text: output.text, details: { verb: 'stop', runId, runSource: source, result: output.value } };
}

async function resumeCommand(host: P2OCommandHost, command: Extract<P2OCommand, { verb: 'resume' }>, ctx: ExtensionCommandContext): Promise<CommandOutcome> {
  const port = await entryPort(host, ctx);
  const { runId, source } = await resolveRunId(host, ctx, command.runId);
  const run = await port.resume(runId, ctx.signal);
  assertRun(run, runId);
  recordRun(host, run.runId, run.state);
  return {
    text: `resumed run ${safeText(runId, 160)} (state ${safeText(run.state, 80)}). Scope, inputs and deadline were re-checked before continuing; conversation replay does not restore a worker environment.`,
    details: { verb: 'resume', runId, runSource: source, state: run.state },
  };
}

async function helpCommand(host: P2OCommandHost, ctx: ExtensionCommandContext): Promise<CommandOutcome> {
  let current = host.registry.currentRunId;
  if (!current) {
    const port = await tryEntryPort(host, ctx);
    if (port?.currentRun) {
      try { current = (await port.currentRun(ctx.signal))?.runId; } catch { current = undefined; }
    }
  }
  return { text: p2oHelp(current), details: { verb: 'help', currentRun: current ?? null } };
}

async function execute(host: P2OCommandHost, command: P2OCommand, ctx: ExtensionCommandContext): Promise<CommandOutcome> {
  switch (command.verb) {
    case 'help': return helpCommand(host, ctx);
    case 'start': return startCommand(host, command, ctx);
    case 'approve': return approveCommand(host, command, ctx);
    case 'resume': return resumeCommand(host, command, ctx);
    case 'status':
    case 'stop':
    case 'report': return lifecycleCommand(host, command, ctx);
  }
}

/** Run one `/p2o` invocation. Never throws: failures are emitted as `p2o_error` messages. */
export async function runP2OCommand(host: P2OCommandHost, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const emit = host.emit ?? ((): void => {});
  const notify = (message: string, type: 'info' | 'error'): void => {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  };
  let command: P2OCommand;
  try { command = parseP2OArgs(args); }
  catch (error) {
    const message = failureMessage(error);
    emit({ customType: 'p2o_error', content: message, display: true });
    notify(message, 'error');
    return;
  }
  try {
    const outcome = await execute(host, command, ctx);
    emit({ customType: 'p2o_result', content: outcome.text, display: true, details: publicValue(outcome.details) });
    notify('p2o: receipt available', 'info');
  } catch (error) {
    const message = failureMessage(error);
    emit({ customType: 'p2o_error', content: message, display: true });
    notify(message, 'error');
  }
}
