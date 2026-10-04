import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { InterfaceController } from '../../src/interface/controller.js';
import { createDefaultBackend } from '../../src/interface/default-backend.js';
import { runP2OCommand, type P2OCommandHost } from '../../src/interface/command.js';
import { SessionRunRegistry, type SessionEntryLike } from '../../src/interface/session-state.js';
import { boundedOutput, publicError, safeText } from '../../src/interface/presentation.js';
import { schemas, type Action } from '../../src/interface/schemas.js';
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
}

/** Host-only UI consent and bounded native completion. Never inherits parent selection as authority. */
function hostPlanAuthor(ctx: ExtensionCommandContext): unknown {
  return createHostPiPlanAuthor(ctx);
}
const descriptions: Record<Action, string> = {
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

/** Public test/integration seam. Factory registration itself opens no resources. */
export function registerP2O(pi: ExtensionAPI, options: P2OExtensionOptions = {}): InterfaceController {
  const controller = new InterfaceController(options.backendFactory ?? createDefaultBackend, options.ownerStorageRoot);
  const registry = new SessionRunRegistry();
  const host: P2OCommandHost = {
    controller,
    registry,
    appendEntry: (customType, data) => { if (typeof pi.appendEntry === 'function') pi.appendEntry(customType, data); },
    emit: message => pi.sendMessage(message, { triggerTurn: false }),
    planAuthorFor: options.planAuthorFor ?? hostPlanAuthor,
    onboardingFor: options.onboardingFor,
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
          const result = await controller.execute(action, params, ctx.cwd, signal, privateLink(ctx), 'tool');
          const output = boundedOutput(result);
          return { content: [{ type: 'text', text: output.text }], details: output.value };
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
    description: 'One entrypoint: /p2o --target <local-dir|github-https-repo|http(s)-URL> [--plan-only --budget USD --deadline minutes --concurrency N --repo-scripts --state-changes] (first-use human UI) | status|stop|resume|report [runId] | approve <planId>',
    handler: async (args: string, ctx: ExtensionCommandContext) => { await runP2OCommand(host, args, ctx); },
  });

  pi.on('session_start', (_event, ctx) => {
    registry.hydrate(branchEntries(ctx));
    if (ctx.hasUI) ctx.ui.setStatus('p2o', `p2o idle · parent selection ${safeText(ctx.model?.provider, 160)}/${safeText(ctx.model?.id, 240)}/${safeText(ctx.thinkingLevel, 20)} (not worker attestation)`);
    // Do not auto-start, auto-resume, load manifests or start a dashboard here.
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    try { await controller.close(); }
    catch (error) {
      if (ctx.hasUI) ctx.ui.notify(publicError(error).message, 'error');
      throw publicError(error);
    } finally { if (ctx.hasUI) ctx.ui.setStatus('p2o', undefined); }
  });
  return controller;
}

export default function p2oExtension(pi: ExtensionAPI): void { registerP2O(pi); }
