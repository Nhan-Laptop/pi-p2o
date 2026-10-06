import { writeSync } from 'node:fs';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { InterfaceController } from '../../src/interface/controller.js';
import { createDefaultBackend } from '../../src/interface/default-backend.js';
import { runP2OCommand, type P2OCommandHost, type P2OTextWriter } from '../../src/interface/command.js';
import { SessionRunRegistry, type SessionEntryLike } from '../../src/interface/session-state.js';
import { boundedOutput, publicError, safeText } from '../../src/interface/presentation.js';
import { schemas, validate, type Action } from '../../src/interface/schemas.js';
import { ForegroundOrchestrator } from '../../src/interface/foreground.js';
import type { BackendFactory } from '../../src/interface/types.js';
import { createHostPiPlanAuthor } from '../../src/application/entry/pi-author.js';
import type { OnboardingHandler } from '../../src/application/onboarding/index.js';

export interface P2OExtensionOptions {
  backendFactory?: BackendFactory;
  /** Host-only injection for UI/storage contract tests. No model or command argument can select it. */
  onboardingFor?: OnboardingHandler;
  /** Host-only owner storage root, forwarded to the bundled backend so a fresh-process `resume` can locate the
   * original consent bundle. Production omits it and uses the shipped default location. */
  ownerStorageRoot?: string;
  /**
   * Host-only planning/setup seam. The default asks the human to select an assessment model, price/budget
   * and boundary through the normal Pi UI, then uses its native completion/auth APIs. Parent selection
   * is not assessment consent; returning undefined fails closed rather than substituting a fixture plan.
   */
  planAuthorFor?: (ctx: ExtensionCommandContext) => unknown;
  /**
   * Host-only raw transport for Pi's one-shot text print surface (`pi -p`). Production omits it and
   * writes to file descriptor 1, the only channel that reaches real stdout under Pi's non-interactive
   * stdout takeover. Tests inject a recorder; no model or command argument can select it.
   */
  textPrintWriterFor?: P2OTextWriter;
}

/** Host-only UI consent and bounded native completion. Never inherits parent selection as authority. */
function hostPlanAuthor(ctx: ExtensionCommandContext): unknown {
  return createHostPiPlanAuthor(ctx);
}
const descriptions: Record<Action, string> = {
  orchestrate: 'Coordinate the live foreground run in this Pi session: read offline planning context, propose an unapproved bounded draft, wait for durable progress, or finish with a terminal qualified report. Cannot activate from session replay, approve a plan or launch target work.',
  start: 'Start a user-requested scoped workflow using the real managed supervisor. Requires owner-approved manifest and explicit fixture/assessment mode; never grants permission.',
  status: 'Read durable run/process, packet acceptance, finding verification, coverage, failures and requested-versus-observed runtime receipts independently.',
  stop: 'Cancel scheduling and stop supervisor-owned runtime execution; success requires verified termination, not merely a parent-model abort.',
  resume: 'Reconcile and resume an existing managed run only after current scope/input/deadline checks. Conversation replay does not restore a worker environment.',
  preflight: 'Validate approved scope, manifest identities and runtime/tool prerequisites without launching workers or making target requests. Passing is not permission.',
  doctor: 'Report scope/runtime/tool preflight blockers and missing capabilities. Does not install tools, widen scope or fall back to fixture mode.',
  tasks: 'Read paginated task metadata, process and packet states. Process exit does not establish accepted results.',
  evidence: 'Read paginated preserved evidence receipt metadata by run or evidence ID; never returns raw credentials, artifact bytes or ownership tokens.',
  report: 'Read a qualified redacted report including accepted facts, limitations, unresolved coverage and execution failures; never upgrades hypotheses to verified findings.',
  events: 'Read paginated durable lifecycle receipts and collector-redacted log summaries, with explicit cursor/gap semantics.',
  dashboard: 'Explicitly open or close a token-protected loopback GET-only read dashboard. Access token is delivered only through user-facing UI, never model output. Closing does not stop workers.',
  switch_model: 'Request an owner-gated model switch for one leased attempt. The owner-approved switch proposal and the supervisor decide; this call grants nothing and an unapproved switch is refused.',
  subtask: 'Request a supervisor-adjudicated discovered subtask for one leased attempt. Scope, budget, role, depth and concurrency can only narrow the parent; an owner denial is recorded and creates no task.',
  plan: 'Propose or read a target-driven plan batch. Approval is an explicit human command (`/p2o approve <planId>`) and is never available to a tool: `action: "approve"` is refused. This tool never fabricates, edits or widens an approval.',
};

function branchEntries(ctx: ExtensionContext): readonly SessionEntryLike[] {
  try {
    const manager = ctx.sessionManager as unknown as { getBranch?: () => unknown } | undefined;
    const branch = manager?.getBranch?.();
    return Array.isArray(branch) ? branch as SessionEntryLike[] : [];
  } catch { return []; }
}

/** Bound on stdout write attempts so a stalled non-blocking pipe cannot hang the command. */
const STDOUT_WRITE_RETRIES = 200;

/**
 * Write plain text to the process's real stdout. Pi takes over `process.stdout.write` in every
 * non-interactive mode (`core/output-guard` in Pi 1.0.0) so incidental chatter cannot corrupt stdout,
 * which leaves a direct file-descriptor write as the only channel onto the one-shot text print surface.
 */
export async function writeStdoutText(text: string): Promise<void> {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  for (let attempts = 0; offset < buffer.length; attempts += 1) {
    if (attempts > STDOUT_WRITE_RETRIES) throw new Error('stdout write made no progress');
    try { offset += writeSync(1, buffer, offset); }
    catch (error) {
      // A non-blocking pipe can refuse the write with EAGAIN; waiting for the reader is not a failure.
      if ((error as NodeJS.ErrnoException)?.code !== 'EAGAIN') throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

/**
 * Plain-text sink for `/p2o` on surfaces that have no transcript UI. Only `ctx.mode === 'print'` is
 * Pi's one-shot text print mode (`pi -p`): there `hasUI` is false, `ctx.ui` is the runner's no-op UI,
 * `process.stdout.write` is redirected to stderr and no custom message is rendered, so command output
 * is invisible unless it is written straight to fd 1. `json`/`rpc` reserve stdout for protocol records
 * and `tui` renders the emitted `p2o_result`/`p2o_error` message, so no text sink is bound there. Text
 * is best-effort: a failed write is reported on stderr and never changes a reported outcome.
 */
export function createP2OTextSink(ctx: ExtensionContext, write: P2OTextWriter = writeStdoutText): P2OTextWriter | undefined {
  if (ctx.mode !== 'print') return undefined;
  return async text => {
    try { await write(text.endsWith('\n') ? text : `${text}\n`); }
    catch (error) { process.stderr.write(`p2o: text print output failed: ${publicError(error).message}\n`); }
  };
}

/** Public test/integration seam. Factory registration itself opens no resources. */
export function registerP2O(pi: ExtensionAPI, options: P2OExtensionOptions = {}): InterfaceController {
  const controller = new InterfaceController(options.backendFactory ?? createDefaultBackend, options.ownerStorageRoot);
  const registry = new SessionRunRegistry();
  const foreground = new ForegroundOrchestrator(pi, controller, registry);
  const host: P2OCommandHost = {
    controller,
    registry,
    appendEntry: (customType, data) => { if (typeof pi.appendEntry === 'function') pi.appendEntry(customType, data); },
    emit: message => pi.sendMessage(message, { triggerTurn: false }),
    textPrintFor: ctx => createP2OTextSink(ctx, options.textPrintWriterFor),
    planAuthorFor: options.planAuthorFor ?? hostPlanAuthor,
    onboardingFor: options.onboardingFor,
    foreground,
  };
  const privateLink = (ctx: ExtensionContext): ((link: string) => void) | undefined => ctx.hasUI
    ? link => ctx.ui.notify(`Private read-only dashboard (do not share): ${link}`, 'info') : undefined;

  for (const action of Object.keys(schemas) as Action[]) {
    const name = `p2o_${action}`;
    pi.registerTool({
      name,
      label: `p2o ${action}`,
      description: `${descriptions[action]} Display limited to 48KiB; record pages are at most 100 items. Use pagination when truncated.`,
      promptSnippet: descriptions[action],
      promptGuidelines: [
        `Use ${name} only for the user's requested p2o workflow. Calling ${name}, possessing targets or passing preflight does not establish authorization.`,
        `The human entrypoint is the single /p2o command; ${name} is the agent surface and no tool call replaces user confirmation.`,
        `${name} preserves process completion, packet acceptance, finding verification and coverage as distinct states; do not infer permission or success from model prose or process exit.`,
        ...(action === 'start' || action === 'resume' ? [
          `${name} requires explicit fixture/assessment mode and a currently owner-approved manifest. Never invent authorization references, select fixture as an isolation fallback, or bypass a scope/preflight blocker.`,
          `${name} selection is requested provider/model/thinking only; report observed worker receipts from p2o_status separately.`,
        ] : []),
        ...(action === 'stop' ? ['Use p2o_stop for actual owned-runtime cancellation; closing a dashboard or cancelling the parent Pi model is not a verified worker stop.'] : []),
        ...(action === 'dashboard' ? ['Use p2o_dashboard open only on explicit user opt-in with enabled:true. Do not put its private access URL in prompts, session entries or reports.'] : []),
        ...(action === 'plan' ? [
          'Use p2o_plan propose with a planner-authored packet path; it stores the proposal and returns the exact digest the owner must approve. Nothing is admitted by propose.',
          `Never attempt ${name} approval from a tool: action "approve" is refused with APPROVAL_HUMAN_ONLY. Ask the human to run /p2o approve <planId> after reviewing the scope, actions and spend.`,
        ] : []),
      ],
      parameters: schemas[action],
      async execute(_id, params, signal, onUpdate, ctx) {
        try {
          if (action === 'start' || action === 'resume') onUpdate?.({ content: [{ type: 'text', text: 'Checking scope and runtime prerequisites; no acceptance or verification is implied.' }], details: {} });
          validate(action, params);
          const foregroundStopping = action === 'stop' && foreground.runId === (params as { runId: string }).runId;
          const denied = foreground.guard(name, params);
          if (denied) throw new Error(denied);
          if (action === 'stop' && foreground.stopPlanning((params as { runId: string }).runId)) {
            return { content: [{ type: 'text', text: 'Foreground planning cancelled. No worker was admitted; no runtime-termination success is claimed.' }], details: { planningCancelled: true, workersStarted: false }, terminate: true };
          }
          if (action === 'stop') foreground.beforeStop((params as { runId: string }).runId);
          const result = action === 'orchestrate'
            ? await foreground.execute(validate('orchestrate', params), ctx, signal)
            : await controller.execute(action, params, ctx.cwd, signal, privateLink(ctx), 'tool');
          if (action === 'stop') foreground.stopped((params as { runId: string }).runId);
          const output = boundedOutput(result);
          return { content: [{ type: 'text', text: output.text }], details: output.value, ...(foregroundStopping ? { terminate: true } : {}) };
        } catch (error) {
          // Pi marks failures only when execute throws. Never return a fake isError/success envelope.
          throw publicError(error);
        }
      },
    });
  }

  // Exactly one human slash command. No `/p2o_<action>` registrations: the p2o_* tools stay available for
  // agent/script use, but the human grammar is `/p2o` only.
  pi.registerCommand('p2o', {
    description: 'One entrypoint: /p2o --target <local-dir|github-https-repo|http(s)-URL> [--foreground|--headless --plan-only --deadline minutes --concurrency N --repo-scripts --state-changes] (TUI: current Pi orchestrator; human approval; sandboxed workers) | status|stop|resume|report [runId] | approve <planId>',
    handler: async (args: string, ctx: ExtensionCommandContext) => { await runP2OCommand(host, args, ctx); foreground.deliverPending(); },
  });

  // Exposure alone is not a boundary: direct, nested and codemode calls all pass this gate.
  pi.on('tool_call', event => {
    const reason = foreground.guard(event.toolName, event.input);
    if (reason) return { block: true, reason };
  });
  pi.on('user_bash', () => {
    if (foreground.active) return { result: { output: 'Host shell is disabled during foreground orchestration. Use /p2o stop before leaving this control workspace.', exitCode: 1, cancelled: false, truncated: false } };
  });
  pi.on('before_agent_start', event => {
    const instructions = foreground.instructions();
    if (instructions) event.systemPromptOptions.sections.p2o_orchestration = instructions;
    else delete event.systemPromptOptions.sections.p2o_orchestration;
  });
  pi.on('context', event => ({ messages: event.messages.filter(message => {
    const custom = message as { customType?: string; details?: { runId?: string } };
    return custom.customType !== 'p2o_orchestrator' || custom.details?.runId === foreground.runId;
  }) }));
  pi.on('message_end', async event => {
    if (event.message.role === 'assistant') await foreground.recordUsage(event.message);
  });
  pi.on('agent_before_settle', async event => {
    await foreground.settled(event.outcome);
    const continuation = foreground.takeContinuation();
    if (continuation) return { entries: [{ type: 'custom_message', customType: 'p2o_orchestrator', content: continuation.content, display: true, details: continuation.details }], continue: true };
  });
  const leaveWorkspace = async (): Promise<{ cancel?: boolean } | undefined> => {
    try { await foreground.cancel('Pi session/branch change'); }
    catch { return { cancel: true }; }
  };
  pi.on('session_before_switch', leaveWorkspace);
  pi.on('session_before_fork', leaveWorkspace);
  pi.on('session_before_tree', leaveWorkspace);
  pi.on('model_select', async (_event, ctx) => {
    if (foreground.active) { await foreground.cancel('foreground model changed; fresh consent required'); ctx.ui.notify('p2o foreground stopped for model change. Start again to approve the new session model.', 'info'); }
  });
  pi.on('thinking_level_select', async (_event, ctx) => {
    if (foreground.active) { await foreground.cancel('foreground thinking changed; fresh consent required'); ctx.ui.notify('p2o foreground stopped for thinking change. Start again to approve the new selection.', 'info'); }
  });

  pi.on('session_start', (_event, ctx) => {
    registry.hydrate(branchEntries(ctx));
    if (ctx.hasUI) ctx.ui.setStatus('p2o', `p2o idle · parent selection ${safeText(ctx.model?.provider, 160)}/${safeText(ctx.model?.id, 240)}/${safeText(ctx.thinkingLevel, 20)} (not worker attestation)`);
    // Do not auto-start, auto-resume, load manifests or start a dashboard here.
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    foreground.dispose();
    try { await controller.close(); }
    catch (error) {
      if (ctx.hasUI) ctx.ui.notify(publicError(error).message, 'error');
      throw publicError(error);
    } finally { if (ctx.hasUI) ctx.ui.setStatus('p2o', undefined); }
  });
  return controller;
}

export default function p2oExtension(pi: ExtensionAPI): void { registerP2O(pi); }
