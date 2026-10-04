/**
 * `TargetEntryPort` implementation for the single human `/p2o` command.
 *
 * Flow: prepare (offline resolution + bounded read-only fingerprint, zero target requests) → plan
 * (model-authored packet through the existing planner/generated-request APIs, sealed by digest) → human
 * approval → post-approval acquisition (read-only snapshot or hardened clone) → owner-gated materialization
 * and registration → delegation to the existing supervisor backend.
 * Authority rules: `prepare`/`plan` never clone, never start a worker and never request the target;
 * `start`/`approve` consume a controller-issued human-confirmation capability bound to the sealed
 * run/scope/plan, mint (or reuse) the exact owner approval artifact, and run the existing owner gate
 * before any clone, target request or delegation. An externally authored owner document is preserved and
 * still verified by the ledger; the workflow never widens the owner run document or invents scope.
 */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { digestJson } from '../../contracts/index.js';
import type {
  EntryApprovalReceipt, EntryApproveInput, EntryHumanApproval, EntryPlan, EntryPlanInput, EntryPreparation,
  EntryPrepareInput, EntryReadPlan, EntryRun, EntryRunSummary, EntryStartInput, EntryTargetKind,
} from '../../interface/target-entry.js';
import { consumeHumanConfirmationCapability } from '../../interface/human-approval.js';
import { sealPlanDigest, planFactsFor, validatePlanAuthorOutput } from './authoring.js';
import { cloneGitHubRepoSafely, createProcessRunner, privateDestination } from './clone.js';
import { createBackendDelegation } from './delegation.js';
import { entryFail, safeText } from './errors.js';
import { createEntryPlanStore } from './plans.js';
import { createReadOnlySnapshot, fingerprintTree, type EntryTreeFingerprint } from './snapshot.js';
import { resolveEntryTarget, type ResolvedEntryTarget } from './targets.js';
import { ENTRY_BOUNDS_DEFAULTS, type EntryAcquisition, type EntryApprovalMintRequest, type EntryBounds, type EntryDelegationPort, type EntryOwnerSelection, type EntryPlanPacket, type EntryPlanStore, type EntryRunBinding, type StoredEntryPlan, type TargetEntryOptions } from './types.js';
import { ENTRY_TECHNIQUE_ROUTES, assertOwnerAction, skillsFor } from './techniques.js';

/** Local identity is lexical before consent; filesystem canonicalization/copy is acquisition-only. */
function resolveOffline(input: Parameters<typeof resolveEntryTarget>[0]): ResolvedEntryTarget {
  if (input.target.kind !== 'local-dir') return resolveEntryTarget(input);
  const locator = resolve(input.cwd, input.target.locator);
  const approved = input.binding.approvedTargets.find(candidate => (candidate.kind === 'artifact' || candidate.kind === 'lab') && resolve(candidate.locator) === locator);
  if (!approved) entryFail('TARGET_DENIED', 'local directory is outside the owner-approved lexical identity');
  const route = ENTRY_TECHNIQUE_ROUTES['local-dir'];
  assertOwnerAction(route, approved.actions, approved.targetId);
  return { target: { ...input.target, locator }, approved, route, mode: input.binding.mode, skills: skillsFor('local-dir', input.depth), localRoot: locator, warnings: ['Directory existence, symlinks and immutable bytes will be checked only after exact plan approval.'] };
}

interface PendingPreparation {
  preparation: EntryPreparation;
  binding: EntryRunBinding;
  resolved: ResolvedEntryTarget;
  depth: EntryPrepareInput['depth'];
  purpose?: string;
  fingerprint?: EntryTreeFingerprint;
}

const MAX_WARNING_CHARS = 300;

function warningsOf(...groups: Array<readonly string[] | undefined>): string[] {
  const all = groups.flatMap(group => group ?? []).map(warning => safeText(warning, MAX_WARNING_CHARS)).filter(Boolean);
  return [...new Set(all)].slice(0, 12);
}

function runSegment(runId: string): string {
  const segment = runId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
  if (!segment || segment === '.' || segment === '..') entryFail('ENTRY_FAILED', 'run identity cannot be used as a private directory name');
  return segment;
}

function effectiveSpend(run: EntryRunBinding['run'], requestedBudgetUsd: number | undefined, now: number): EntryPreparation['spend'] {
  const ownerCost = run.budgets.maxCostUsd;
  const maxCostUsd = requestedBudgetUsd === undefined ? ownerCost : Math.min(requestedBudgetUsd, ownerCost);
  return {
    maxCostUsd,
    maxRequests: run.budgets.maxRequests,
    maxTokens: run.budgets.maxTokens,
    maxToolCalls: run.budgets.maxToolCalls,
    maxAttempts: run.budgets.maxAttempts,
    deadlineMs: Math.max(0, Date.parse(run.budgets.deadlineAt) - now),
  };
}

function effectiveConcurrency(run: EntryRunBinding['run'], requested: number | undefined): number {
  const owner = Math.max(1, run.budgets.maxConcurrency);
  return requested === undefined ? owner : Math.max(1, Math.min(requested, owner));
}

export function createTargetEntryPort(options: TargetEntryOptions): import('../../interface/target-entry.js').TargetEntryPort {
  if (!options.workspaceRoot || !options.workspaceRoot.startsWith('/') || resolve(options.workspaceRoot) !== options.workspaceRoot) {
    entryFail('ENTRY_INTEGRATION_REQUIRED', 'entry workspace root must be a canonical absolute path');
  }
  const workspaceRoot = options.workspaceRoot;
  const viewsRoot = join(workspaceRoot, 'entry-views');
  const gitRoot = join(workspaceRoot, 'entry-git');
  const bounds: EntryBounds = { ...ENTRY_BOUNDS_DEFAULTS, ...options.bounds };
  const clock = options.clock ?? Date.now;
  const newId = options.newId ?? (() => randomUUID());
  const observer = options.observer;
  const runner = options.commandRunner ?? createProcessRunner();

  const store: EntryPlanStore = createEntryPlanStore({
    root: join(workspaceRoot, 'entry-control'),
    clock,
    digestOf: record => sealPlanDigest({
      preparation: record.preparation,
      steps: record.plan.steps,
      packet: record.packet,
      proposalId: record.proposalId,
      proposalDigest: record.proposalDigest,
    }),
  });

  const pending = new Map<string, PendingPreparation>();
  const plansByScope = new Map<string, string>();
  const delegations = new Map<string, EntryDelegationPort>();

  const bindingNow = async (): Promise<EntryRunBinding> => {
    const binding = typeof options.binding === 'function' ? await options.binding() : options.binding;
    if (!binding || !binding.run || typeof binding.run.runId !== 'string') entryFail('ENTRY_INTEGRATION_REQUIRED', 'the composition supplied no owner-approved run binding');
    if (binding.mode !== 'fixture' && binding.mode !== 'assessment') entryFail('ENTRY_INTEGRATION_REQUIRED', 'the owner run binding must declare fixture or assessment mode');
    return binding;
  };

  const boundsFor = (run: EntryRunBinding['run']): EntryBounds => ({
    ...bounds,
    maxTotalBytes: Math.max(1, Math.min(bounds.maxTotalBytes, run.budgets.maxBytes)),
  });

  const delegationFor = (binding: EntryRunBinding): EntryDelegationPort => {
    if (options.delegation) return options.delegation;
    const cached = delegations.get(binding.manifestPath);
    if (cached) return cached;
    const created = createBackendDelegation({
      backend: binding.backend,
      manifestPath: binding.manifestPath,
      mode: binding.mode,
      ...(binding.selection ? { selection: binding.selection } : {}),
    });
    delegations.set(binding.manifestPath, created);
    return created;
  };

  const scopeIdentity = (preparation: {
    runId: string; target: EntryPreparation['target']; mode: EntryPreparation['mode']; actions: string[];
    spend: EntryPreparation['spend']; concurrency: number; planOnly: boolean;
  }): string => digestJson({
    version: 1,
    runId: preparation.runId,
    target: {
      kind: preparation.target.kind,
      locator: preparation.target.locator,
      ...(preparation.target.digest ? { digest: preparation.target.digest } : {}),
      ...(preparation.target.revision ? { revision: preparation.target.revision } : {}),
    },
    mode: preparation.mode,
    actions: [...preparation.actions],
    spend: preparation.spend,
    concurrency: preparation.concurrency,
    planOnly: preparation.planOnly,
  });

  const keyOf = (preparation: EntryPreparation): string => `${preparation.runId}\u0000${preparation.scopeDigest}`;

  /** Re-check a preparation returned by `prepare()` (or read from the store) before acting on it. */
  const verifyPreparation = async (preparation: EntryPreparation, binding: EntryRunBinding): Promise<{ resolved: ResolvedEntryTarget; pending?: PendingPreparation }> => {
    if (!preparation || typeof preparation !== 'object') entryFail('ENTRY_FAILED', 'no preparation was supplied');
    if (preparation.requiresHumanApproval !== true) entryFail('ENTRY_FAILED', 'preparation does not require human approval');
    if (preparation.targetRequests !== 0) entryFail('ENTRY_FAILED', 'preparation reports target requests; entry never acts on it');
    if (preparation.runId !== binding.run.runId) entryFail('ENTRY_FAILED', 'preparation belongs to another run than the owner-approved document');
    const expected = scopeIdentity(preparation);
    if (expected !== preparation.scopeDigest) entryFail('SCOPE_DIGEST_MISMATCH', 'preparation fields no longer match the approved scope digest');
    const remembered = pending.get(keyOf(preparation));
    if (remembered) return { resolved: remembered.resolved, pending: remembered };
    const resolved = resolveOffline({
      target: preparation.target,
      binding,
      cwd: options.cwd,
      depth: 'standard',
      ...(observer ? { observer } : {}),
    });
    if (resolved.target.locator !== preparation.target.locator) {
      entryFail('SCOPE_DIGEST_MISMATCH', 'the target no longer resolves to the approved canonical locator');
    }
    return { resolved };
  };

  const verifyApproval = (approval: EntryHumanApproval, preparation: EntryPreparation, plan: EntryPlan): void => {
    if (!approval || typeof approval !== 'object' || approval.channel !== 'human-command') {
      entryFail('ENTRY_FAILED', 'entry only accepts a human-command approval minted by the interactive /p2o command');
    }
    if (approval.scopeDigest !== preparation.scopeDigest) entryFail('SCOPE_DIGEST_MISMATCH', 'the approval is for another scope digest than this preparation');
    if (approval.planDigest !== plan.digest) entryFail('SCOPE_DIGEST_MISMATCH', 'the approval is for another plan digest than the sealed plan');
  };

  /** Bounded default lifetime of a controller-minted approval; always clamped to the owner window. */
  const APPROVAL_TTL_MS = 15 * 60 * 1000;

  const approvalExpiry = (run: EntryRunBinding['run']): string => {
    const now = clock();
    const end = Math.min(now + Math.max(1, options.approvalTtlMs ?? APPROVAL_TTL_MS), Date.parse(run.authorization.expiresAt), Date.parse(run.budgets.deadlineAt));
    if (!Number.isFinite(end) || end <= now) {
      entryFail('ENTRY_APPROVAL_WINDOW', 'the owner authorization window or the absolute run deadline has already ended; nothing is minted and the target is not touched');
    }
    return new Date(end).toISOString();
  };

  const approvalCounts = (stored: StoredEntryPlan): Pick<EntryApprovalMintRequest, 'requestCount' | 'taskCount' | 'observationCount'> => {
    const packet = stored.packet as { kind: EntryPlanPacket['kind']; proposal: { requests?: unknown; tasks?: unknown; observations?: unknown } };
    const proposal = packet.proposal;
    if (packet.kind === 'generated-requests') {
      return { requestCount: Array.isArray(proposal.requests) ? proposal.requests.length : 0 };
    }
    return {
      taskCount: Array.isArray(proposal.tasks) ? proposal.tasks.length : 0,
      observationCount: Array.isArray(proposal.observations) ? proposal.observations.length : 0,
    };
  };

  /**
   * Resolve the exact owner approval artifact for one sealed proposal before any target I/O.
   *
   * An owner-authored document always wins (headless workflows keep working) and is left untouched. When
   * none exists, only a consumed human confirmation plus a composition-owned approval store can create one;
   * it is written atomically, owner-only, for the stored proposal identity and inside the owner window.
   */
  const ensureApprovalArtifact = async (input: {
    stored: StoredEntryPlan;
    preparation: EntryPreparation;
    binding: EntryRunBinding;
    human?: { approvalRef: string; approvedAt: string };
  }): Promise<string | undefined> => {
    const approvals = options.approvals;
    if (!approvals) return undefined;
    const kind = input.stored.packet.kind === 'generated-requests' ? 'request' as const : 'plan' as const;
    if (await approvals.exists(kind, input.stored.proposalDigest)) return undefined;
    if (!input.human) {
      entryFail('ENTRY_HUMAN_APPROVAL_REQUIRED',
        'no owner approval artifact exists for this exact sealed proposal and this approval carries no controller-issued human confirmation; confirm it in the interactive /p2o command or have the owner author the document');
    }
    const written = await approvals.write({
      kind,
      runId: input.preparation.runId,
      proposalId: input.stored.proposalId,
      proposalDigest: input.stored.proposalDigest,
      approvalRef: input.human.approvalRef,
      approvedAt: input.human.approvedAt,
      expiresAt: approvalExpiry(input.binding.run),
      ...approvalCounts(input.stored),
    });
    observer?.decision?.({ step: 'approval-minted', detail: `${kind} ${input.stored.proposalDigest.slice(0, 12)} ${written.reused ? 'reused' : 'created'}` });
    return written.path;
  };

  const requireStored = async (planId: string): Promise<StoredEntryPlan> => {
    const stored = await store.read(planId);
    if (!stored) entryFail('PLAN_NOT_FOUND', `no entry plan ${safeText(planId, 120)} is stored`);
    return stored;
  };

  const requireExecution = async (packet: EntryPlanPacket) => {
    const execution = options.executions?.[packet.kind];
    if (!execution) {
      if (packet.kind === 'generated-requests') {
        entryFail('ENTRY_GENERATED_REQUESTS_UNSUPPORTED',
          'the composed runtime exposes no generated-request execution adapter; bind the request ledger, the owner envelope, an owner-authored approval document path and a grant-registration callback (see docs/architecture/target-entry.md)');
      }
      entryFail('ENTRY_OWNER_MENU_UNSUPPORTED',
        'the composed runtime exposes no owner-menu execution adapter; bind the plan ledger, an owner-authored approval document path, the workspace resolver and a check-registration callback (see docs/architecture/target-entry.md)');
    }
    const available = await execution.available();
    if (!available.ok) entryFail(available.code, available.message);
    return execution;
  };

  /** Post-approval acquisition. Nothing here runs before a matching human approval is verified. */
  const acquire = async (input: {
    preparation: EntryPreparation;
    resolved: ResolvedEntryTarget;
    binding: EntryRunBinding;
    signal?: AbortSignal;
  }): Promise<EntryAcquisition> => {
    const { preparation, resolved, binding } = input;
    const runBounds = boundsFor(binding.run);
    if (resolved.target.kind === 'local-dir') {
      const root = resolved.localRoot;
      if (!root) entryFail('ENTRY_FAILED', 'local target lost its canonical root');
      const observed = await fingerprintTree({
        root, bounds: runBounds,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(observer ? { observer } : {}),
      });
      if (preparation.target.digest && observed.digest !== preparation.target.digest) {
        entryFail('SCOPE_DIGEST_MISMATCH', 'the local target changed after preparation; the approved content digest no longer matches');
      }
      if (resolved.approved.digest && observed.digest !== resolved.approved.digest) {
        entryFail('SCOPE_DIGEST_MISMATCH', 'the local target content does not match the owner-pinned content digest');
      }
      const destination = privateDestination(viewsRoot, runSegment(preparation.runId), 'source');
      const snapshot = await createReadOnlySnapshot({
        root,
        destination,
        bounds: runBounds,
        expectedDigest: observed.digest,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(observer ? { observer } : {}),
      });
      const warnings = warningsOf(resolved.warnings, [
        ...(resolved.approved.revision && resolved.approved.revision !== observed.digest.slice(0, 12)
          ? [`owner revision pin ${safeText(resolved.approved.revision, 80)} is a label; the enforced identity is the content digest`]
          : []),
        ...(snapshot.skippedSymlinks ? [`${snapshot.skippedSymlinks} symlink(s) were excluded from the read-only view`] : []),
        ...(snapshot.skippedUnsafePaths ? [`${snapshot.skippedUnsafePaths} unsafe path name(s) were excluded`] : []),
      ]);
      return { kind: 'local-dir', locator: destination, digest: snapshot.digest, readOnly: true, files: snapshot.files, bytes: snapshot.bytes, warnings };
    }
    if (resolved.target.kind === 'github-repo') {
      const repoUrl = resolved.repoUrl;
      if (!repoUrl) entryFail('ENTRY_FAILED', 'GitHub target lost its canonical URL');
      const destination = privateDestination(viewsRoot, runSegment(preparation.runId), 'repo');
      const cloned = await cloneGitHubRepoSafely({
        repoUrl,
        destination,
        privateRoot: join(gitRoot, runSegment(preparation.runId)),
        runner,
        bounds: runBounds,
        ...(resolved.approved.revision ? { expectedRevision: resolved.approved.revision } : {}),
        ...(resolved.approved.digest ? { expectedDigest: resolved.approved.digest } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(observer ? { observer } : {}),
        ...(options.gitBinary ? { gitBinary: options.gitBinary } : {}),
        inspect: async root => {
          // The shared walker excludes symlinks; never reinterpret checkout links as ordinary source text.
          const walked = await fingerprintTree({ root, bounds: runBounds, ...(input.signal ? { signal: input.signal } : {}) });
          return { files: walked.files, bytes: walked.bytes };
        },
      });
      const walked = await fingerprintTree({ root: destination, bounds: runBounds, ...(input.signal ? { signal: input.signal } : {}) });
      if (resolved.approved.revision && resolved.approved.revision !== cloned.revision) {
        entryFail('SCOPE_DIGEST_MISMATCH', 'the resolved commit does not match the owner-pinned revision');
      }
      if (resolved.approved.digest && resolved.approved.digest !== walked.digest) {
        entryFail('SCOPE_DIGEST_MISMATCH', 'the cloned tree does not match the owner-pinned content digest');
      }
      const warnings = warningsOf(resolved.warnings, [
        ...(walked.skippedSymlinks ? [`${walked.skippedSymlinks} symlink(s) were excluded from the clone view`] : []),
      ]);
      return { kind: 'github-repo', locator: destination, revision: cloned.revision, digest: walked.digest, readOnly: true, files: walked.files, bytes: walked.bytes, warnings };
    }
    return {
      kind: 'http-url',
      locator: resolved.webUrl ?? preparation.target.locator,
      readOnly: true,
      warnings: warningsOf(resolved.warnings, [
        'the entry workflow issues no request to the target; bounded reconnaissance executes only through owner-approved observations under the broker policy',
      ]),
    };
  };

  /** Shared post-approval path: acquire → register → delegate. */
  const execute = async (input: {
    binding: EntryRunBinding;
    preparation: EntryPreparation;
    resolved: ResolvedEntryTarget;
    stored: StoredEntryPlan;
    approval: EntryHumanApproval;
    signal?: AbortSignal;
  }): Promise<EntryRun> => {
    const { binding, preparation, resolved, stored, approval } = input;
    const plan = stored.plan;
    verifyApproval(approval, preparation, plan);
    // Consume the controller-issued human confirmation once, bound to exactly this run/scope/plan. An
    // externally authored approval file (headless workflow) may omit it; the owner gate still decides.
    const human = approval.authority === undefined
      ? undefined
      : consumeHumanConfirmationCapability(approval.authority, { runId: preparation.runId, scopeDigest: preparation.scopeDigest, planDigest: plan.digest });
    const already = await store.admitted(plan.planId);
    if (already) entryFail('ALREADY_APPROVED', `plan ${safeText(plan.planId, 120)} was already admitted as run ${safeText(already.runId, 120)}`);
    const execution = await requireExecution(stored.packet);
    // Controller-side mint (or reuse) of the exact owner approval artifact, before any clone or network.
    const approvalPath = await ensureApprovalArtifact({ stored, preparation, binding, ...(human ? { human } : {}) });
    // Owner gate *before* acquisition: an expired, foreign, mutated or unapproved proposal is refused
    // before the entry workflow clones or copies anything.
    if (execution.authorize) {
      await execution.authorize({ preparation, plan, approval, proposalId: stored.proposalId, proposalDigest: stored.proposalDigest });
    }
    // Read-only readiness re-check before any acquisition: a blocked composition must not clone or copy.
    const delegation = delegationFor(binding);
    const readiness = await delegation.preflight({ preparation, plan, approval });
    if (!readiness.ok) {
      const detail = readiness.issues.map(issue => `${issue.code}: ${issue.message}`).join('; ') || 'no explicit issue was reported';
      entryFail('ENTRY_DELEGATION_BLOCKED', `the composed backend is not ready for run ${safeText(preparation.runId, 120)}: ${safeText(detail, 500)}`);
    }
    if (readiness.runId && readiness.runId !== preparation.runId) {
      entryFail('ENTRY_DELEGATION_FAILED', 'the composed backend bound another run identity than the approved preparation');
    }
    const acquisition = await acquire({ preparation, resolved, binding, ...(input.signal ? { signal: input.signal } : {}) });
    const completion = await execution.complete({
      preparation,
      plan,
      approval,
      proposalId: stored.proposalId,
      proposalDigest: stored.proposalDigest,
      acquisition,
    });
    const delegated = await delegation.delegate({
      preparation,
      plan,
      approval,
      acquisition,
      ...(completion ? { completion } : {}),
    });
    if (delegated.runId !== preparation.runId) {
      entryFail('ENTRY_DELEGATION_FAILED', 'the delegated launch returned another run identity than the approved preparation');
    }
    const admitted = await store.markAdmitted(plan.planId, delegated.runId);
    if (!admitted) entryFail('ALREADY_APPROVED', `plan ${safeText(plan.planId, 120)} was admitted concurrently; nothing new was launched`);
    observer?.decision?.({ step: 'delegated', detail: `${safeText(delegated.runId, 80)} ${safeText(delegated.state, 40)}` });
    return {
      runId: delegated.runId,
      state: delegated.state,
      planId: plan.planId,
      approvalRef: approval.approvalRef,
      ...(approvalPath ? { approvalPath } : {}),
      mode: preparation.mode,
    };
  };

  /**
   * Expand a bounded model selection into a full owner-data `PlanProposal`. The controller, not the
   * model, authors every identity/budget/scope field; a composition that supplies no builder refuses the
   * flavour instead of fabricating a proposal.
   */
  const expandOwnerMenuSelection = async (input: {
    output: unknown;
    preparation: EntryPreparation;
    binding: EntryRunBinding;
    targetId: string;
    available: { ownerMenu: boolean; generatedRequests: boolean };
  }): Promise<unknown> => {
    const output = input.output;
    if (output === null || typeof output !== 'object' || Array.isArray(output)) return output;
    const packet = (output as { packet?: unknown }).packet;
    if (packet === null || typeof packet !== 'object' || Array.isArray(packet)) return output;
    if ((packet as { kind?: unknown }).kind !== 'owner-menu-selection') return output;
    const selection = (packet as { selection?: unknown }).selection;
    if (!Array.isArray(selection) || selection.length === 0) {
      entryFail('ENTRY_PLAN_INVALID', 'an owner-menu selection must name at least one owner-approved observation');
    }
    if (!options.buildOwnerMenuProposal) {
      entryFail('ENTRY_OWNER_MENU_UNSUPPORTED',
        'the composed runtime supplies no owner-menu proposal builder, so a model-authored selection cannot be expanded into an owner-data proposal (see docs/architecture/target-entry.md)');
    }
    const expanded = await options.buildOwnerMenuProposal({
      selection: selection as EntryOwnerSelection[],
      preparation: input.preparation,
      binding: input.binding,
      targetId: input.targetId,
    });
    return { ...(output as Record<string, unknown>), packet: { kind: 'owner-menu', proposal: expanded.proposal } };
  };

  return Object.freeze({
    async prepare(input: EntryPrepareInput, signal?: AbortSignal): Promise<EntryPreparation> {
      if (!input || typeof input !== 'object') entryFail('ENTRY_FAILED', 'prepare requires an input object');
      const binding = await bindingNow();
      const resolved = resolveOffline({
        target: input.target,
        binding,
        cwd: options.cwd,
        depth: input.depth,
        ...(observer ? { observer } : {}),
      });
      if (signal?.aborted) entryFail('CANCELLED', 'preparation cancelled');
      const fingerprint: EntryTreeFingerprint | undefined = undefined;
      const warnings: string[] = [...resolved.warnings, 'Preparation/planning perform zero target filesystem/network I/O; source acquisition needs immutable identity approval before workers.'];
      if (input.planOnly) warnings.push('plan-only: no acquisition or worker launch');
      const target = {
        kind: resolved.target.kind,
        raw: resolved.target.raw,
        locator: resolved.target.locator,
        ...(resolved.approved.digest ? { digest: resolved.approved.digest } : {}),
        ...(preparationRevision(resolved, fingerprint) ? { revision: preparationRevision(resolved, fingerprint)! } : {}),
      };
      const spend = effectiveSpend(binding.run, input.budgetUsd, clock());
      const concurrency = effectiveConcurrency(binding.run, input.concurrency);
      const actions = resolved.approved.actions.filter(action => binding.run.authorization.allowedActions.includes(action));
      if (!actions.length) entryFail('TARGET_DENIED', 'the resolved target has no owner-approved action within run authorization');
      const scopeDigest = scopeIdentity({
        runId: binding.run.runId,
        target,
        mode: binding.mode,
        actions,
        spend,
        concurrency,
        planOnly: input.planOnly,
      });
      const preparation: EntryPreparation = {
        runId: binding.run.runId,
        target,
        mode: binding.mode,
        scopeDigest,
        actions,
        spend,
        concurrency,
        warnings: warningsOf(warnings, [
          `technique ${resolved.route.capability} on owner target ${resolved.approved.targetId}; no exploit or post-exploitation authority is implied`,
        ]),
        requiresHumanApproval: true,
        targetRequests: 0,
        planOnly: input.planOnly,
      };
      pending.set(keyOf(preparation), {
        preparation, binding, resolved, depth: input.depth,
        ...(input.purpose ? { purpose: input.purpose } : {}),
      });
      observer?.decision?.({ step: 'prepared', detail: `${preparation.target.kind} ${safeText(preparation.target.locator, 120)}` });
      return preparation;
    },

    async plan(input: EntryPlanInput, signal?: AbortSignal): Promise<EntryPlan> {
      if (!input || typeof input !== 'object' || !input.preparation) entryFail('ENTRY_FAILED', 'plan requires the preparation returned by prepare');
      const binding = await bindingNow();
      const { resolved, pending: remembered } = await verifyPreparation(input.preparation, binding);
      if (!options.planAuthor) {
        entryFail('ENTRY_PLAN_AUTHOR_REQUIRED',
          'no model-authored plan seam is wired: bind the Pi/planner runtime author (see docs/architecture/target-entry.md); entry never substitutes a hardcoded plan');
      }
      const samplePaths = remembered?.fingerprint?.samplePaths ?? [];
      const available = {
        ownerMenu: Boolean(options.executions?.['owner-menu']),
        generatedRequests: Boolean(options.executions?.['generated-requests']),
      };
      const output = await options.planAuthor.author({
        preparation: input.preparation,
        ...(remembered?.purpose ? { purpose: remembered.purpose } : {}),
        depth: remembered?.depth ?? 'standard',
        facts: planFactsFor({
          preparation: input.preparation,
          binding,
          samplePaths,
          targetId: resolved.approved.targetId,
          ...(binding.requestEnvelope ? { envelope: binding.requestEnvelope } : {}),
        }),
        techniques: [resolved.route.capability],
        skills: [...resolved.skills],
        available,
      }, signal);
      const expanded = await expandOwnerMenuSelection({ output, preparation: input.preparation, binding, targetId: resolved.approved.targetId, available });
      const validated = validatePlanAuthorOutput({
        output: expanded,
        preparation: input.preparation,
        run: binding.run,
        binding,
        technique: resolved.route.capability,
        targetId: resolved.approved.targetId,
        ...(binding.requestEnvelope ? { envelope: binding.requestEnvelope } : {}),
      });
      if (validated.authoredBy !== 'model' && options.allowFixtureAuthor !== true) {
        entryFail('ENTRY_PLAN_AUTHOR_REQUIRED',
          'the plan author reported fixture authorship; production requires the real model-authored Pi planner seam');
      }
      const execution = await requireExecution(validated.packet);
      const proposal = await execution.propose({ packet: validated.packet, preparation: input.preparation });
      const planId = `plan-${String(newId()).replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 64)}`;
      const digest = sealPlanDigest({
        preparation: input.preparation,
        steps: validated.steps,
        packet: validated.packet,
        proposalId: proposal.proposalId,
        proposalDigest: proposal.proposalDigest,
      });
      const plan: EntryPlan = { planId, runId: input.preparation.runId, digest, steps: validated.steps, targetRequests: 0 };
      await store.save({
        version: 1,
        planId,
        runId: input.preparation.runId,
        digest,
        scopeDigest: input.preparation.scopeDigest,
        mode: binding.mode,
        manifestPath: binding.manifestPath,
        preparation: input.preparation,
        plan,
        packet: validated.packet,
        proposalId: proposal.proposalId,
        proposalDigest: proposal.proposalDigest,
        createdAt: new Date(clock()).toISOString(),
      });
      plansByScope.set(keyOf(input.preparation), planId);
      observer?.decision?.({ step: 'planned', detail: `${planId} ${validated.packet.kind}` });
      return plan;
    },

    async start(input: EntryStartInput, signal?: AbortSignal): Promise<EntryRun> {
      if (!input || typeof input !== 'object' || !input.preparation) entryFail('ENTRY_FAILED', 'start requires the preparation and approval it was given');
      // The direct flow never starts a plan-only preparation; `/p2o approve <planId>` is the executable path.
      if (input.preparation.planOnly) {
        entryFail('ENTRY_FAILED', 'a plan-only preparation cannot be started directly; approve its planId to acquire and run it');
      }
      const binding = await bindingNow();
      const { resolved } = await verifyPreparation(input.preparation, binding);
      const planId = input.plan?.planId ?? plansByScope.get(keyOf(input.preparation));
      if (!planId) entryFail('PLAN_NOT_FOUND', 'no sealed plan is known for this preparation; run /p2o --target again');
      const stored = await requireStored(planId);
      if (input.plan && input.plan.digest !== stored.plan.digest) {
        entryFail('SCOPE_DIGEST_MISMATCH', 'the supplied plan does not match the sealed stored plan');
      }
      return await execute({ binding, preparation: stored.preparation, resolved, stored, approval: input.approval, ...(signal ? { signal } : {}) });
    },

    async resume(runId: string, signal?: AbortSignal): Promise<EntryRun> {
      signal?.throwIfAborted();
      const binding = await bindingNow();
      const runs = await store.runs();
      const known = runs.find(candidate => candidate.runId === runId);
      if (!known) {
        entryFail('ENTRY_RUN_UNKNOWN',
          `the entry workflow cannot re-check inputs for run ${safeText(runId, 120)}; conversation replay is not an environment restore, so re-run /p2o --target to prepare a current scope`);
      }
      const stored = await requireStored(known.planId);
      await verifyPreparation(stored.preparation, binding);
      const now = clock();
      if (Date.parse(binding.run.authorization.expiresAt) <= now) entryFail('ENTRY_FAILED', 'the owner authorization window has ended; resume never renews scope');
      if (Date.parse(binding.run.budgets.deadlineAt) <= now) entryFail('ENTRY_FAILED', 'the absolute run deadline has passed; it cannot be extended');
      // Original checkout mutation is irrelevant once approved bytes were snapshotted. The composition's
      // delegation must revalidate the original immutable binding, and fails closed when it cannot restore it.
      if (stored.preparation.target.kind !== 'http-url' && !options.delegation) entryFail('ENTRY_SOURCE_UNBOUND', 'source resume requires an immutable-source-aware composition delegation; never re-read/reclone the mutable origin');
      const resumed = await delegationFor(binding).resume({
        runId,
        preparation: stored.preparation,
        plan: stored.plan,
      });
      return {
        runId: resumed.runId,
        state: resumed.state,
        planId: stored.plan.planId,
        mode: stored.preparation.mode,
      };
    },

    async readPlan(planId: string): Promise<EntryReadPlan | null> {
      const stored = await store.read(planId);
      if (!stored) return null;
      return { preparation: stored.preparation, plan: stored.plan };
    },

    async approve(input: EntryApproveInput, signal?: AbortSignal): Promise<EntryApprovalReceipt> {
      if (!input || typeof input !== 'object' || !input.planId) entryFail('ENTRY_FAILED', 'approve requires a planId, its digest and a human approval');
      const binding = await bindingNow();
      const stored = await requireStored(input.planId);
      if (input.planDigest !== stored.plan.digest) {
        entryFail('SCOPE_DIGEST_MISMATCH', 'the approval names a different plan digest than the sealed plan');
      }
      const already = await store.admitted(stored.plan.planId);
      if (already) return { planId: stored.plan.planId, approved: true, admittedOnce: false };
      const { resolved } = await verifyPreparation(stored.preparation, binding);
      const run = await execute({ binding, preparation: stored.preparation, resolved, stored, approval: input.approval, ...(signal ? { signal } : {}) });
      return { planId: stored.plan.planId, approved: true, admittedOnce: true, run };
    },

    async currentRun(): Promise<EntryRunSummary | null> {
      const runs = await store.runs();
      const distinct = [...new Map(runs.map(run => [run.runId, run])).values()];
      if (distinct.length !== 1) return null;
      const [only] = distinct;
      if (!only) return null;
      return { runId: only.runId, targetKind: only.targetKind as EntryTargetKind, startedAt: only.startedAt };
    },
  });
}

/** Local fingerprints become the observed revision; GitHub revisions are resolved after the clone. */
function preparationRevision(resolved: ResolvedEntryTarget, fingerprint: EntryTreeFingerprint | undefined): string | undefined {
  if (resolved.target.kind === 'local-dir' && fingerprint) return fingerprint.digest.slice(0, 12);
  return resolved.approved.revision;
}

/** Ensure the private workspace exists before any acquisition; called by the production factory. */
export async function ensureEntryWorkspace(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
}
