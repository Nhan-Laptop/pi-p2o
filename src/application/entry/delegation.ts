/**
 * Delegation to the existing supervisor backend.
 *
 * The entry workflow owns resolution, acquisition and planning, and then hands the run to the composed
 * `ControlBackend`: `preflight` re-runs the composition's own readiness/scope gate, `start` admits the
 * owner-approved run and launches its owners, `resume` re-checks the durable identity and deadline. There is
 * no second orchestration engine here, and no launch without a passing preflight.
 */
import type { RuntimeSelection } from '../../contracts/index.js';
import type { ControlBackend } from '../../interface/types.js';
import { entryFail, safeText } from './errors.js';
import type { EntryPlan, EntryPreparation } from '../../interface/target-entry.js';
import type { EntryDelegationInput, EntryDelegationPort, EntryDelegationPreflight, EntryDelegationPreflightInput } from './types.js';
import type { ApprovedSourceContainerBinding } from '../source-binding/container.js';

export interface BackendDelegationOptions {
  backend: ControlBackend;
  /** Canonical absolute path of the owner-approved run document the backend validates. */
  manifestPath: string;
  mode: 'fixture' | 'assessment';
  /** Runtime selection override for the delegated launch; never rewrites owner authorization. */
  selection?: RuntimeSelection;
  /** Composition-owned hook: register approved observations before `start`; called after preflight passes. */
  onBeforeDelegate?(input: EntryDelegationInput, source?: ApprovedSourceContainerBinding): Promise<void>;
  /** Composition installs the acquired per-run sandbox and exact task/collector fingerprints here. */
  bindSource?(input: EntryDelegationInput): Promise<ApprovedSourceContainerBinding>;
  /** Operational source compositions set this; absence of a real binding then fails closed. */
  requireSourceBinding?: boolean;
  /** Resume must restore/re-verify the SAME controller binding, never re-clone mutable HEAD. */
  sourceForResume?(runId: string): Promise<ApprovedSourceContainerBinding | undefined>;
  /** Read the observed run state; defaults to `backend.status(runId)` projected to its `state`. */
  observe?(runId: string): Promise<string | undefined>;
}

function stateOf(snapshot: unknown): string | undefined {
  if (snapshot === null || typeof snapshot !== 'object') return undefined;
  const run = (snapshot as { run?: unknown }).run;
  if (run === null || typeof run !== 'object') return undefined;
  const state = (run as { state?: unknown }).state;
  return typeof state === 'string' && state.length > 0 ? safeText(state, 80) : undefined;
}

export function createBackendDelegation(options: BackendDelegationOptions): EntryDelegationPort {
  const bound = new Map<string, ApprovedSourceContainerBinding>();
  const verifyBinding = async (source: ApprovedSourceContainerBinding, preparation: EntryPreparation, plan?: EntryPlan): Promise<void> => {
    const id = source.source.identity;
    if (source.sandbox.mode !== 'container' || id.runId !== preparation.runId || id.scopeDigest !== preparation.scopeDigest || (plan && id.planDigest !== plan.digest) || id.origin !== preparation.target.locator || id.kind !== preparation.target.kind || (preparation.target.digest && id.digest !== preparation.target.digest) || (id.kind === 'github-repo' && preparation.target.revision && id.revision !== preparation.target.revision) || source.inputRoot !== source.sandbox.filesystem.inputRoot || source.fingerprints.configurationDigest !== source.sandbox.configurationDigest || source.fingerprints.sourceIdentityDigest !== source.source.identityDigest) entryFail('ENTRY_SOURCE_UNBOUND', 'delegation source identity/configuration does not match the approved acquired mount');
    await source.assertCurrent();
    source.assertEvidenceScope({ environmentId: source.fingerprints.environmentId, configurationDigest: source.fingerprints.configurationDigest, inputs: [...source.fingerprints.inputs] });
  };
  const observe = async (runId: string): Promise<string | undefined> => {
    if (options.observe) return await options.observe(runId);
    try { return stateOf(await options.backend.status(runId)); }
    catch { return undefined; }
  };

  const preflight = async (_input: EntryDelegationPreflightInput): Promise<EntryDelegationPreflight> => {
    const request = {
      manifestPath: options.manifestPath,
      mode: options.mode,
      ...(options.selection ? { selection: options.selection } : {}),
    };
    let result;
    try { result = await options.backend.preflight(request); }
    catch (error) {
      return {
        ok: false,
        runId: '',
        issues: [{ code: 'ENTRY_DELEGATION_BLOCKED', message: `the composed backend refused preflight: ${safeText(error instanceof Error ? error.message : String(error), 300)}` }],
        warnings: [],
      };
    }
    return {
      ok: result.ok && result.issues.length === 0,
      runId: result.runId,
      issues: result.issues.slice(0, 10).map(issue => ({ code: safeText(issue.code, 80), message: safeText(issue.message, 300) })),
      warnings: result.warnings.slice(0, 20).map(warning => safeText(warning, 300)),
    };
  };

  return Object.freeze({
    preflight,
    async delegate(input: EntryDelegationInput) {
      let source: ApprovedSourceContainerBinding | undefined;
      if (input.acquisition.kind !== 'http-url') {
        if (options.bindSource) {
          source = await options.bindSource(input);
          await verifyBinding(source, input.preparation, input.plan);
          if (source.source.identity.digest !== input.acquisition.digest || source.source.identity.revision !== input.acquisition.revision) entryFail('ENTRY_SOURCE_UNBOUND', 'delegation binding substituted a different acquired digest/commit');
        } else if (options.requireSourceBinding) entryFail('ENTRY_SOURCE_UNBOUND', 'source delegation needs the approved per-run source container factory; comparing the original owner root is not binding');
      }
      const ready = await preflight({ preparation: input.preparation, plan: input.plan, approval: input.approval });
      if (!ready.ok) {
        const detail = ready.issues.map(issue => `${issue.code}: ${issue.message}`).join('; ') || 'no explicit issue was reported';
        entryFail('ENTRY_DELEGATION_BLOCKED', `the composed backend did not pass preflight for run ${safeText(input.preparation.runId, 120)}: ${safeText(detail, 500)}`);
      }
      if (ready.runId && ready.runId !== input.preparation.runId) {
        entryFail('ENTRY_DELEGATION_FAILED', 'the composed backend bound another run identity than the owner-approved preparation');
      }
      if (options.onBeforeDelegate) await options.onBeforeDelegate(input, source);
      if (source) { await verifyBinding(source, input.preparation, input.plan); bound.set(input.preparation.runId, source); }
      const handle = await options.backend.start({
        manifestPath: options.manifestPath,
        mode: options.mode,
        ...(options.selection ? { selection: options.selection } : {}),
      });
      if (handle.runId !== input.preparation.runId) {
        entryFail('ENTRY_DELEGATION_FAILED', 'the composed backend launched another run identity than the owner-approved preparation');
      }
      return { runId: handle.runId, state: (await observe(handle.runId)) ?? 'admitted' };
    },
    async resume(input: { runId: string; preparation: EntryPreparation; plan?: EntryPlan }) {
      if (input.runId !== input.preparation.runId) entryFail('ENTRY_SOURCE_UNBOUND', 'source resume belongs to another run');
      if (input.preparation.target.kind !== 'http-url' && (options.requireSourceBinding || options.bindSource)) {
        const source = (await options.sourceForResume?.(input.runId)) ?? bound.get(input.runId);
        if (!source) entryFail('ENTRY_SOURCE_UNBOUND', 'source resume requires the original verified immutable binding; never re-clone or silently bind the owner root');
        await verifyBinding(source, input.preparation, input.plan);
      }
      const ready = await preflight({
        preparation: input.preparation,
        plan: input.plan ?? { planId: 'resume', runId: input.runId, digest: '', steps: [], targetRequests: 0 },
        approval: { channel: 'human-command', approvalRef: 'resume', approvedAt: new Date().toISOString(), scopeDigest: input.preparation.scopeDigest, planDigest: '' },
      });
      if (!ready.ok) {
        const detail = ready.issues.map(issue => `${issue.code}: ${issue.message}`).join('; ') || 'no explicit issue was reported';
        entryFail('ENTRY_DELEGATION_BLOCKED', `the composed backend did not pass preflight for run ${safeText(input.runId, 120)}: ${safeText(detail, 500)}`);
      }
      const handle = await options.backend.resume({
        runId: input.runId,
        manifestPath: options.manifestPath,
        mode: options.mode,
        ...(options.selection ? { selection: options.selection } : {}),
      });
      if (handle.runId !== input.runId) entryFail('ENTRY_DELEGATION_FAILED', 'the composed backend resumed another run identity');
      return { runId: handle.runId, state: (await observe(handle.runId)) ?? 'resumed' };
    },
  } satisfies EntryDelegationPort);
}
