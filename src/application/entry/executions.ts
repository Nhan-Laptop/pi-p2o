/**
 * Execution adapters over the existing planner and generated-request APIs.
 *
 * These adapters do not orchestrate anything themselves: `propose` stores and validates the model-authored
 * packet through `PlanLedger.propose` / `RequestPlanLedger.propose`, and `complete` runs the owner-gated
 * `approve` + `materializePlan` / `materializeRequestPlan` sequence and then hands the materialized checks and
 * grants to a composition-owned registration callback. The owner approval document is read from an
 * owner-authored path (or created once by `approvals.ts` from a consumed human confirmation) and is always
 * verified by the ledger; these adapters never invent scope, digests, counts or authority.
 */
import { planProposalDigest, planProposalSchema, validatePlanProposal, type PlanProposal, type RunManifest, type RuntimeSelection } from '../../contracts/index.js';
import {
  planRequestEnvelopeSchema, planRequestProposalSchema, validatePlanRequestProposal,
  type PlanRequestEnvelope, type PlanRequestProposal,
} from '../../contracts/plan-request.js';
import type { Role } from '../../orchestrator/index.js';
import { materializePlan, type MaterializedPlan, type MaterializedRequestPlan, type PlanLedger, type RequestPlanLedger } from '../planner.js';
import { readOwnerDocument } from './documents.js';
import { entryFail, safeText } from './errors.js';
import type {
  EntryAcquisition, EntryPlanExecution, EntryPlanExecutionCompleteInput, EntryPlanExecutionCompletion, EntryPlanExecutionProposeInput,
} from './types.js';

function boundedIssues(issues: ReadonlyArray<{ code: string; path: string; message: string }>): string {
  return issues.slice(0, 3).map(issue => `${issue.code} ${safeText(issue.path, 80)}: ${safeText(issue.message, 200)}`).join('; ');
}

/**
 * Owner-authored approval document location. A function receives the sealed proposal digest, so the
 * owner can author exactly one document per proposal (the composition only ever reads it).
 */
export type EntryOwnerDocumentPath = string | ((proposalDigest: string) => string);

function resolveOwnerDocumentPath(path: EntryOwnerDocumentPath | undefined, digest: string): string | undefined {
  if (path === undefined) return undefined;
  return typeof path === 'function' ? path(digest) : path;
}

function attemptIdFor(preparation: { scopeDigest: string }): string {
  return `entry-plan-${preparation.scopeDigest.slice(0, 32)}`;
}

function completionOf(
  proposalId: string,
  proposalDigest: string,
  registered: { taskIds?: unknown; observationIds?: unknown },
  fallbackObservationIds: readonly string[],
): EntryPlanExecutionCompletion {
  const taskIds = Array.isArray(registered.taskIds) ? registered.taskIds.filter((value): value is string => typeof value === 'string') : [];
  const observationIds = Array.isArray(registered.observationIds)
    ? registered.observationIds.filter((value): value is string => typeof value === 'string')
    : [...fallbackObservationIds];
  return { proposalId, proposalDigest, taskIds: [...new Set(taskIds)], observationIds: [...new Set(observationIds)] };
}

// ---------------------------------------------------------------------------------------------
// Generated HTTP requests (`RequestPlanLedger` + `materializeRequestPlan`).
// ---------------------------------------------------------------------------------------------

export interface GeneratedRequestExecutionOptions {
  ledger: RequestPlanLedger;
  run: RunManifest;
  envelope: PlanRequestEnvelope;
  /** Owner-authored `PlanRequestApprovalDocument`; required before completion is available. */
  ownerDocumentPath?: EntryOwnerDocumentPath;
  /** Composition-owned registration of the materialized checks + grants into per-attempt policy. */
  register?: (input: {
    preparation: EntryPlanExecutionCompleteInput['preparation'];
    plan: EntryPlanExecutionCompleteInput['plan'];
    approval: EntryPlanExecutionCompleteInput['approval'];
    materialized: MaterializedRequestPlan;
    /** Observed post-approval acquisition, when one was made; binds worker source roots. */
    acquisition?: EntryAcquisition;
  }) => Promise<{ taskIds?: unknown; observationIds?: unknown }>;
  taskFor?: (taskId: string) => { question?: { text: string }; surfaceId?: string; actorId?: string } | undefined;
  selection?: RuntimeSelection;
  now?: () => number;
}

export function createGeneratedRequestExecution(options: GeneratedRequestExecutionOptions): EntryPlanExecution {
  // Fail early when the envelope is not even schema-valid: an invalid envelope can never approve anything.
  const envelope = planRequestEnvelopeSchema.parse(options.envelope);
  const missing = (): string => {
    const gaps: string[] = [];
    if (!options.ownerDocumentPath) gaps.push('an owner-authored request-approval document path');
    if (!options.register) gaps.push('a generated-check registration callback');
    return gaps.join(' and ');
  };
  return Object.freeze({
    kind: 'generated-requests' as const,
    async available() {
      const gaps = missing();
      if (gaps) {
        return {
          ok: false as const,
          code: 'ENTRY_GENERATED_REQUESTS_UNSUPPORTED',
          message: `the composed runtime cannot execute generated requests: bind ${gaps} (see docs/architecture/target-entry.md)`,
        };
      }
      return { ok: true as const };
    },
    async propose(input: EntryPlanExecutionProposeInput) {
      if (input.packet.kind !== 'generated-requests') entryFail('ENTRY_PLAN_INVALID', 'generated-request execution requires a generated-requests packet');
      const parsed = planRequestProposalSchema.safeParse(input.packet.proposal);
      if (!parsed.success) entryFail('ENTRY_PLAN_INVALID', `generated-request packet is not schema-valid: ${boundedIssues(parsed.issues.map(issue => ({ code: 'schema', path: String(issue.path), message: issue.message })))}`);
      const issues = validatePlanRequestProposal(parsed.data, { run: options.run, envelope });
      if (issues.length) entryFail('ENTRY_PLAN_REJECTED', `generated-request packet is outside the owner envelope: ${boundedIssues(issues)}`);
      // Provenance identity belongs to the entry controller, not the model: normalize it before the ledger
      // seals the packet (the ledger refuses a mismatched generator/packet digest).
      const proposal: PlanRequestProposal = {
        ...parsed.data,
        generator: {
          generatorAttemptId: attemptIdFor(input.preparation),
          generatorKind: 'worker',
          requestedSelection: options.selection ?? parsed.data.generator.requestedSelection,
          inputDigests: [input.preparation.scopeDigest],
          producedAt: parsed.data.generator.producedAt,
        },
      };
      const outcome = options.ledger.propose({
        packet: proposal,
        run: options.run,
        envelope,
        generatorAttemptId: attemptIdFor(input.preparation),
        generatorKind: 'worker',
        ...(options.selection ? { requestedSelection: options.selection } : {}),
        inputDigests: [input.preparation.scopeDigest],
      });
      if (!outcome.ok) entryFail('ENTRY_PLAN_REJECTED', `the request ledger refused the proposal (${outcome.code}): ${boundedIssues(outcome.issues)}`);
      return { proposalId: outcome.record.proposalId, proposalDigest: outcome.record.digest };
    },
    async authorize(input: EntryPlanExecutionCompleteInput): Promise<void> {
      const gaps = missing();
      if (gaps || !options.ownerDocumentPath) {
        entryFail('ENTRY_GENERATED_REQUESTS_UNSUPPORTED', `the composed runtime cannot execute generated requests: bind ${gaps}`);
      }
      const ownerDocumentPath = resolveOwnerDocumentPath(options.ownerDocumentPath, input.proposalDigest)!;
      const document = readOwnerDocument(ownerDocumentPath, 'owner generated-request approval');
      const approved = await options.ledger.approve({ run: options.run, proposalDigest: input.proposalDigest, document });
      if (!approved.ok) entryFail('ENTRY_PLAN_REJECTED', `owner request approval was refused (${approved.code}): ${boundedIssues(approved.issues)}`);
    },
    async complete(input: EntryPlanExecutionCompleteInput): Promise<EntryPlanExecutionCompletion> {
      const gaps = missing();
      if (gaps || !options.ownerDocumentPath || !options.register) {
        entryFail('ENTRY_GENERATED_REQUESTS_UNSUPPORTED', `the composed runtime cannot execute generated requests: bind ${gaps}`);
      }
      // Re-run the owner gate against the same artifact: `approve` is idempotent for an identical document,
      // and this second check happens after acquisition so a swapped document can never ride along.
      const ownerDocumentPath = resolveOwnerDocumentPath(options.ownerDocumentPath, input.proposalDigest)!;
      const document = readOwnerDocument(ownerDocumentPath, 'owner generated-request approval');
      const approved = await options.ledger.approve({ run: options.run, proposalDigest: input.proposalDigest, document });
      if (!approved.ok) entryFail('ENTRY_PLAN_REJECTED', `owner request approval was refused (${approved.code}): ${boundedIssues(approved.issues)}`);
      const materialized = options.ledger.materialize({
        run: options.run,
        proposalDigest: input.proposalDigest,
        envelope,
        ...(options.taskFor ? { taskFor: options.taskFor } : {}),
        ...(options.now ? { now: new Date(options.now()).toISOString() } : {}),
      });
      if (!materialized.ok) entryFail('ENTRY_PLAN_REJECTED', `generated-request materialization was refused (${materialized.code}): ${boundedIssues(materialized.issues)}`);
      const registered = await options.register({
        preparation: input.preparation,
        plan: input.plan,
        approval: input.approval,
        materialized: materialized.plan,
        ...(input.acquisition ? { acquisition: input.acquisition } : {}),
      });
      return completionOf(
        materialized.plan.proposalId,
        materialized.plan.digest,
        registered,
        materialized.plan.checks.map(check => check.observationId),
      );
    },
  } satisfies EntryPlanExecution);
}

// ---------------------------------------------------------------------------------------------
// Owner-menu selections (`PlanLedger` + `materializePlan`).
// ---------------------------------------------------------------------------------------------

export interface OwnerMenuExecutionOptions {
  ledger: PlanLedger;
  run: RunManifest;
  /** Owner-authored `PlanApprovalDocument`; required before completion is available. */
  ownerDocumentPath?: EntryOwnerDocumentPath;
  /** Composition-owned registration of the materialized checks into the attempt check menu. */
  register?: (input: {
    preparation: EntryPlanExecutionCompleteInput['preparation'];
    plan: EntryPlanExecutionCompleteInput['plan'];
    approval: EntryPlanExecutionCompleteInput['approval'];
    materialized: MaterializedPlan;
    /** Observed post-approval acquisition, when one was made; binds worker source roots. */
    acquisition?: EntryAcquisition;
  }) => Promise<{ taskIds?: unknown; observationIds?: unknown }>;
  /** Supervisor-derived private workspace for one task id; required to materialize tasks. */
  workspaceFor?: (taskId: string) => string;
  role?: Role;
  selection?: RuntimeSelection;
  now?: () => number;
}

export function createOwnerMenuExecution(options: OwnerMenuExecutionOptions): EntryPlanExecution {
  const missing = (): string => {
    const gaps: string[] = [];
    if (!options.ownerDocumentPath) gaps.push('an owner-authored plan-approval document path');
    if (!options.register) gaps.push('a check-registration callback');
    if (!options.workspaceFor) gaps.push('the supervisor-derived workspace resolver');
    return gaps.join(' and ');
  };
  return Object.freeze({
    kind: 'owner-menu' as const,
    async available() {
      const gaps = missing();
      if (gaps) {
        return {
          ok: false as const,
          code: 'ENTRY_OWNER_MENU_UNSUPPORTED',
          message: `the composed runtime cannot execute an owner-menu plan: bind ${gaps} (see docs/architecture/target-entry.md)`,
        };
      }
      return { ok: true as const };
    },
    async propose(input: EntryPlanExecutionProposeInput) {
      if (input.packet.kind !== 'owner-menu') entryFail('ENTRY_PLAN_INVALID', 'owner-menu execution requires an owner-menu packet');
      const parsed = planProposalSchema.safeParse(input.packet.proposal);
      if (!parsed.success) entryFail('ENTRY_PLAN_INVALID', `owner-menu packet is not schema-valid: ${boundedIssues(parsed.issues.map(issue => ({ code: 'schema', path: String(issue.path), message: issue.message })))}`);
      const issues = validatePlanProposal(parsed.data, { run: options.run });
      if (issues.length) entryFail('ENTRY_PLAN_REJECTED', `owner-menu packet is outside the owner document: ${boundedIssues(issues)}`);
      // The entry controller owns provenance identity; the model only authors the plan content.
      const proposal: PlanProposal = {
        ...parsed.data,
        provenance: {
          plannerAttemptId: attemptIdFor(input.preparation),
          plannerKind: 'worker',
          requestedSelection: options.selection ?? parsed.data.provenance.requestedSelection,
          inputDigests: [input.preparation.scopeDigest],
          producedAt: parsed.data.provenance.producedAt,
        },
      };
      const outcome = options.ledger.propose({
        packet: proposal,
        run: options.run,
        plannerAttemptId: attemptIdFor(input.preparation),
        ...(options.selection ? { requestedSelection: options.selection } : {}),
        inputDigests: [input.preparation.scopeDigest],
      });
      if (!outcome.ok) entryFail('ENTRY_PLAN_REJECTED', `the plan ledger refused the proposal (${outcome.code}): ${boundedIssues(outcome.issues)}`);
      return { proposalId: outcome.record.proposalId, proposalDigest: outcome.record.digest };
    },
    async authorize(input: EntryPlanExecutionCompleteInput): Promise<void> {
      const gaps = missing();
      if (gaps || !options.ownerDocumentPath) {
        entryFail('ENTRY_OWNER_MENU_UNSUPPORTED', `the composed runtime cannot execute an owner-menu plan: bind ${gaps}`);
      }
      const ownerDocumentPath = resolveOwnerDocumentPath(options.ownerDocumentPath, input.proposalDigest)!;
      const document = readOwnerDocument(ownerDocumentPath, 'owner plan approval');
      const approved = await options.ledger.approve({ run: options.run, proposalDigest: input.proposalDigest, document });
      if (!approved.ok) entryFail('ENTRY_PLAN_REJECTED', `owner plan approval was refused (${approved.code}): ${boundedIssues(approved.issues)}`);
      if (planProposalDigest(approved.proposal) !== input.proposalDigest) {
        entryFail('SCOPE_DIGEST_MISMATCH', 'the stored owner-menu proposal no longer matches the approved digest');
      }
    },
    async complete(input: EntryPlanExecutionCompleteInput): Promise<EntryPlanExecutionCompletion> {
      const gaps = missing();
      if (gaps || !options.ownerDocumentPath || !options.register || !options.workspaceFor) {
        entryFail('ENTRY_OWNER_MENU_UNSUPPORTED', `the composed runtime cannot execute an owner-menu plan: bind ${gaps}`);
      }
      // Re-run the owner gate against the same artifact: `approve` is idempotent for an identical document,
      // and this second check happens after acquisition so a swapped document can never ride along.
      const ownerDocumentPath = resolveOwnerDocumentPath(options.ownerDocumentPath, input.proposalDigest)!;
      const document = readOwnerDocument(ownerDocumentPath, 'owner plan approval');
      const approved = await options.ledger.approve({ run: options.run, proposalDigest: input.proposalDigest, document });
      if (!approved.ok) entryFail('ENTRY_PLAN_REJECTED', `owner plan approval was refused (${approved.code}): ${boundedIssues(approved.issues)}`);
      if (planProposalDigest(approved.proposal) !== input.proposalDigest) {
        entryFail('SCOPE_DIGEST_MISMATCH', 'the stored owner-menu proposal no longer matches the approved digest');
      }
      const now = new Date(options.now ? options.now() : Date.now()).toISOString();
      const materialized = materializePlan(approved.proposal, {
        run: options.run,
        approval: approved.document,
        now,
        workspaceFor: options.workspaceFor,
        ...(options.role ? { role: options.role } : {}),
      });
      const registered = await options.register({
        preparation: input.preparation,
        plan: input.plan,
        approval: input.approval,
        materialized,
        ...(input.acquisition ? { acquisition: input.acquisition } : {}),
      });
      return completionOf(
        materialized.proposalId,
        materialized.digest,
        registered,
        materialized.checks.map(check => check.observationId),
      );
    },
  } satisfies EntryPlanExecution);
}
