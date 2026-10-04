import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  canonicalJson, digestJson, normalizeTargetKey, planApprovalDocumentSchema, planCoverageResolutionSchema, planIssue,
  planProposalDigest, planProposalSchema, readThreatModelBounded, reconcileCoverage, runSchema, threatModelCapsDefaults,
  threatModelSchema, validatePlanProposal, type AttemptRecord, type Budget, type BoundedThreatModel, type CoverageReconciliation, type Digest, type Id,
  type PlanApproval, type PlanApprovalDocument, type PlanCaps, type PlanCoverageCell, type PlanCoverageResolution,
  type JsonObject, type PlanIssue, type PlanProposal, type PlanTask, type RunManifest, type StoredPlanProposal, type ThreatModel, type ThreatModelAmendment,
  type RuntimeSelection,
  type ThreatModelCaps, type Timestamp,
} from '../contracts/index.js';
import {
  planRequestApprovalDocumentSchema, planRequestBinding, planRequestCapsDefaults, planRequestEnvelopeSchema,
  planRequestInput, planRequestProposalDigest, planRequestProposalSchema, validatePlanRequestProposal,
  type PlanRequestApproval, type PlanRequestApprovalDocument, type PlanRequestCaps, type PlanRequestEnvelope,
  type PlanRequestGenerator, type PlanRequestMethod, type PlanRequestProposal, type StoredPlanRequestProposal,
} from '../contracts/plan-request.js';
import type { RequestApprovalAuthority } from './authority.js';
import { ControlFiles, type Authority, type PlanAdmissionBatch, type Role, type SupervisorApi, type TaskProposal } from '../orchestrator/index.js';
import type { ToolPolicy } from '../runtime/types.js';
import type { DurableStore } from '../store/index.js';
import { object, text, ApplicationError, fail } from './validation.js';
import type { CoveragePlanEntry, ObservationCheck, WorkerContextPort } from './types.js';

const MAX_PROPOSAL_BYTES = 1024 * 1024;
const MAX_APPROVAL_BYTES = 256 * 1024;
const MAX_RECORDS = 512;

const instant = (clock?: () => number): Timestamp => new Date((clock ?? Date.now)()).toISOString();

// ---------------------------------------------------------------------------------------------
// Pure materialization: approved proposal -> run configuration (tasks + owner-bound checks + cells).
// ---------------------------------------------------------------------------------------------

export interface PlanMaterializationContext {
  run: RunManifest;
  approval: PlanApprovalDocument;
  now: Timestamp;
  /** Supervisor-derived private workspace for one task id. */
  workspaceFor(taskId: string): string;
  role?: Role;
  /** Optional exact per-task budget; defaults to a deterministic equal division of the run budget. */
  budgetFor?(task: PlanTask): Budget;
}

export interface MaterializedPlan {
  proposalId: Id;
  digest: Digest;
  runId: Id;
  tasks: TaskProposal[];
  checks: ObservationCheck[];
  coverage: CoveragePlanEntry[];
  coverageCells: PlanCoverageCell[];
  threatModelKey?: string;
  taskIds: Id[];
}

function equalShare(total: number, count: number, floor = 0): number {
  return Math.max(floor, Math.floor(total / count));
}

function dividedBudget(run: RunManifest, count: number): Budget {
  return {
    deadlineAt: new Date(Date.parse(run.budgets.deadlineAt) - run.budgets.reportReserveMs).toISOString(),
    maxRequests: equalShare(run.budgets.maxRequests, count, 1),
    maxBytes: equalShare(run.budgets.maxBytes, count, 1),
    maxToolCalls: equalShare(run.budgets.maxToolCalls, count, 1),
    maxTokens: equalShare(run.budgets.maxTokens, count, 1),
    maxCostUsd: run.budgets.maxCostUsd / count,
    maxAttempts: equalShare(run.budgets.maxAttempts, count, 1),
  };
}

/** Deterministic, bounded check id; worker-selected observation ids never become controller identity. */
export function planCheckId(taskId: Id, observationId: Id): Id {
  return `chk-${digestJson({ taskId, observationId }).slice(0, 32)}`;
}

/**
 * Pure function consumed by the composition. It never widens the approved proposal: task ids, questions,
 * depths, dependencies, capabilities and coverage cells come from the proposal; the execution policy comes
 * from the caller (owner document) and the admission run.
 */
export function materializePlan(proposal: PlanProposal, context: PlanMaterializationContext): MaterializedPlan {
  const parsed = planProposalSchema.parse(proposal);
  const run = runSchema.parse(context.run);
  const digest = planProposalDigest(parsed);
  if (context.approval.proposalDigest !== digest || context.approval.proposalId !== parsed.proposalId || context.approval.runId !== run.runId) {
    throw new ApplicationError('plan-approval-binding', 'Approval document is not bound to this exact proposal and run');
  }
  const budget = context.budgetFor ? undefined : dividedBudget(run, Math.max(1, parsed.tasks.length));
  const taskById = new Map(parsed.tasks.map(task => [task.taskId, task]));
  const tasks: TaskProposal[] = parsed.tasks.map(task => {
    const manifestScope = {
      ...parsed.run.scope,
      targetIds: [...task.targetIds],
      actor: { id: task.actor.id, privileges: [...task.actor.privileges] },
    };
    const exclusiveKeys = task.exclusiveKeys ?? [];
    return {
      manifest: {
        schemaVersion: 1, runId: run.runId, taskId: task.taskId,
        dependencyTaskIds: [...task.dependencies], depth: task.depth, createdAt: context.now,
        inputRevision: parsed.run.inputRevision, question: { ...task.question },
        scope: manifestScope,
        skills: [...task.skills], allowedActions: [...task.allowedActions], requiredCapabilities: [...task.requiredCapabilities],
        budgets: context.budgetFor ? context.budgetFor(task) : { ...budget! },
        requestedRuntime: run.requestedRuntime, workspace: context.workspaceFor(task.taskId),
        lifecycleState: 'queued', packetState: 'draft',
      },
      role: context.role ?? 'worker',
      ...(exclusiveKeys.length ? { exclusiveKeys } : {}),
    };
  });
  const checks: ObservationCheck[] = parsed.observations.map(observation => {
    const task = taskById.get(observation.taskId)!;
    return {
      checkId: planCheckId(observation.taskId, observation.observationId),
      taskId: observation.taskId,
      observationId: observation.observationId,
      tool: observation.tool as ObservationCheck['tool'],
      input: JSON.parse(canonicalJson(observation.input)) as ObservationCheck['input'],
      kind: observation.kind,
      classification: observation.classification,
      summary: observation.summary,
      claim: task.question.text,
      surfaceId: task.surfaceId,
      actorId: task.actor.id,
      ...(observation.expectation ? { expectation: observation.expectation } : {}),
    };
  });
  const coverage: CoveragePlanEntry[] = parsed.coverage.map(cell => ({
    surfaceId: cell.surfaceId, actorId: cell.actorId, question: cell.question, taskId: cell.taskId,
    state: 'untested', basis: 'reviewer-validated',
    reason: `Planned coverage cell ${cell.cellId}; not yet resolved`,
  }));
  return {
    proposalId: parsed.proposalId, digest, runId: run.runId,
    tasks, checks, coverage, coverageCells: parsed.coverage.map(cell => ({ ...cell })),
    taskIds: parsed.tasks.map(task => task.taskId),
    ...(parsed.threatModel ? { threatModelKey: parsed.threatModel.targetKey } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Run-scoped threat model: one bounded document per normalized target key, append-only amendments.
// ---------------------------------------------------------------------------------------------

export interface ThreatModelStoreOptions {
  controlRoot: string;
  runId: Id;
  clock?: () => number;
  caps?: Partial<ThreatModelCaps>;
  /** Per-attempt amendment rate limit inside one rolling window. */
  maxAmendmentsPerAttempt?: number;
  amendmentWindowMs?: number;
  minAmendmentChars?: number;
}

export interface ThreatModelSaveInput { targetKey: string; body: string; attemptId: Id; at?: Timestamp; replace?: boolean }
export interface ThreatModelAmendInput { targetKey: string; attemptId: Id; text: string; at?: Timestamp }
export type ThreatModelSaveResult = { ok: true; revision: number; created: boolean } | { ok: false; code: string; message: string };
export type ThreatModelAmendResult = { ok: true; amendmentId: Id; count: number } | { ok: false; code: string; message: string };

export interface ThreatModelStore {
  readonly runId: Id;
  read(targetKey: string, limits?: { maxBodyChars?: number; maxAmendments?: number }): BoundedThreatModel;
  list(): ThreatModel[];
  save(input: ThreatModelSaveInput): ThreatModelSaveResult;
  amend(input: ThreatModelAmendInput): ThreatModelAmendResult;
}

const threatModelKeyFor = (runId: Id, targetKey: string): string => `tm-${createHash('sha256').update(`${runId}\u0000${targetKey}`).digest('hex').slice(0, 32)}`;

export function createThreatModelStore(options: ThreatModelStoreOptions): ThreatModelStore {
  const files = new ControlFiles(options.controlRoot);
  const clock = options.clock ?? Date.now;
  const caps: ThreatModelCaps = {
    maxBodyChars: options.caps?.maxBodyChars ?? threatModelCapsDefaults.maxBodyChars,
    maxAmendmentChars: options.caps?.maxAmendmentChars ?? threatModelCapsDefaults.maxAmendmentChars,
    maxAmendments: options.caps?.maxAmendments ?? threatModelCapsDefaults.maxAmendments,
  };
  const maxPerAttempt = options.maxAmendmentsPerAttempt ?? 3;
  const windowMs = options.amendmentWindowMs ?? 60_000;
  const minChars = options.minAmendmentChars ?? 32;
  const recent = new Map<Id, number[]>();

  function normalized(targetKey: unknown): string {
    if (typeof targetKey !== 'string') fail('threat-model-target', 'A target key is required');
    try { return normalizeTargetKey(targetKey); }
    catch (error) { return fail('threat-model-target', error instanceof Error ? error.message : 'target key is not normalizable'); }
  }

  function load(targetKey: string): ThreatModel | undefined {
    const record = files.read<ThreatModel>('threat-models', threatModelKeyFor(options.runId, targetKey), 4 * 1024 * 1024);
    if (!record) return undefined;
    if (record.runId !== options.runId || record.targetKey !== targetKey) fail('threat-model-scope', 'Stored threat model belongs to another run or target key');
    return threatModelSchema.parse(record);
  }

  function persist(model: ThreatModel): void {
    files.write('threat-models', threatModelKeyFor(model.runId, model.targetKey), threatModelSchema.parse(model), 4 * 1024 * 1024);
  }

  return Object.freeze({
    runId: options.runId,
    read(targetKey: string, limits = {}): BoundedThreatModel {
      const key = normalized(targetKey);
      return readThreatModelBounded(load(key), options.runId, key, limits);
    },
    list(): ThreatModel[] {
      const directory = join(files.root, 'threat-models');
      let names: string[];
      try { names = readdirSync(directory); } catch { return []; }
      const models: ThreatModel[] = [];
      for (const name of names.sort().slice(0, MAX_RECORDS)) {
        if (!name.endsWith('.json')) continue;
        const record = files.read<ThreatModel>('threat-models', name.slice(0, -5), 4 * 1024 * 1024);
        if (record && record.runId === options.runId) models.push(threatModelSchema.parse(record));
      }
      return models;
    },
    save(input: ThreatModelSaveInput): ThreatModelSaveResult {
      const key = normalized(input.targetKey);
      const body = typeof input.body === 'string' ? input.body : '';
      if (body.trim().length === 0) return { ok: false, code: 'threat-model-empty', message: 'Threat-model body cannot be empty' };
      if (body.length > caps.maxBodyChars) return { ok: false, code: 'threat-model-size', message: `Threat-model body exceeds ${caps.maxBodyChars} characters` };
      const existing = load(key);
      if (existing && input.replace !== true) {
        return { ok: false, code: 'threat-model-exists', message: 'A threat model already exists for this target; amend it or replace it explicitly' };
      }
      const at = input.at ?? instant(clock);
      const model: ThreatModel = {
        schemaVersion: 1, runId: options.runId, targetKey: key, body,
        bodyDigest: digestJson(body), revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? at, createdByAttemptId: existing?.createdByAttemptId ?? input.attemptId,
        amendments: input.replace === true ? [] : (existing?.amendments ?? []),
        caps,
      };
      persist(model);
      return { ok: true, revision: model.revision, created: existing === undefined };
    },
    amend(input: ThreatModelAmendInput): ThreatModelAmendResult {
      const key = normalized(input.targetKey);
      const amendment = (input.text ?? '').trim();
      if (amendment.length < minChars) return { ok: false, code: 'threat-model-thin', message: `Amendment is too thin (${amendment.length} characters); say what the model got wrong and what proves it` };
      if (amendment.length > caps.maxAmendmentChars) return { ok: false, code: 'threat-model-amendment-size', message: `Amendment exceeds ${caps.maxAmendmentChars} characters` };
      const model = load(key);
      if (!model) return { ok: false, code: 'threat-model-missing', message: 'No threat model exists for this target yet; derive the baseline before amending' };
      if (model.amendments.length >= caps.maxAmendments) return { ok: false, code: 'threat-model-amendments', message: 'Threat model has reached its amendment cap' };
      const now = (input.at ? Date.parse(input.at) : clock());
      const window = recent.get(input.attemptId) ?? [];
      const kept = window.filter(at => now - at < windowMs);
      if (kept.length >= maxPerAttempt) {
        recent.set(input.attemptId, kept);
        return { ok: false, code: 'threat-model-rate-limit', message: `Attempt ${input.attemptId} has already amended ${maxPerAttempt} time(s) inside the rate window` };
      }
      kept.push(now);
      recent.set(input.attemptId, kept);
      const entry: ThreatModelAmendment = {
        amendmentId: `amd-${digestJson({ attemptId: input.attemptId, at: instant(() => now), text: amendment }).slice(0, 32)}`,
        authorAttemptId: input.attemptId,
        at: input.at ?? instant(() => now),
        digest: digestJson(amendment),
        text: amendment,
      };
      const updated: ThreatModel = { ...model, amendments: [...model.amendments, entry] };
      persist(updated);
      return { ok: true, amendmentId: entry.amendmentId, count: updated.amendments.length };
    },
  }) satisfies ThreatModelStore;
}

// ---------------------------------------------------------------------------------------------
// Durable plan ledger: propose / read / approve / coverage reconciliation.
// ---------------------------------------------------------------------------------------------

export interface PlanLedgerOptions {
  controlRoot: string;
  authority: Authority;
  clock?: () => number;
  caps?: Partial<PlanCaps>;
  threatModelCaps?: Partial<ThreatModelCaps>;
  maxProposalsPerRun?: number;
  threatModelOptions?: Pick<ThreatModelStoreOptions, 'maxAmendmentsPerAttempt' | 'amendmentWindowMs' | 'minAmendmentChars'>;
}

export interface PlanProposeInput {
  packet: unknown;
  run: RunManifest;
  plannerAttemptId: Id;
  requestedSelection?: PlanProposal['provenance']['requestedSelection'];
  inputDigests?: Digest[];
  producedAt?: Timestamp;
  caps?: Partial<PlanCaps>;
}

export type PlanProposeOutcome =
  | { ok: true; record: PlanRecord }
  | { ok: false; code: string; issues: PlanIssue[]; packetDigest: Digest };

export type PlanApproveOutcome =
  | { ok: true; approval: PlanApproval; document: PlanApprovalDocument; proposal: PlanProposal; record: PlanApprovalRecord; duplicate: boolean }
  | { ok: false; code: string; issues: PlanIssue[] };

export interface PlanRecord extends StoredPlanProposal { version: 1 }
export interface PlanApprovalRecord {
  version: 1;
  runId: Id;
  proposalId: Id;
  digest: Digest;
  approval: PlanApproval;
  approvalDocumentDigest: Digest;
  approvedAt: Timestamp;
  admittedTaskIds: Id[];
}
interface PlanRejectionRecord {
  version: 1; runId: Id; at: Timestamp; packetDigest: Digest; code: string; issues: PlanIssue[]; plannerAttemptId: Id;
}
interface PlanCoverageRecord { version: 1; runId: Id; cellId: Id; digest: Digest; resolution: PlanCoverageResolution }

export interface PlanReadResult {
  runId: Id;
  proposals: Array<{ proposalId: Id; digest: Digest; storedAt: Timestamp; plannerAttemptId: Id; taskCount: number; observationCount: number; coverageCount: number; approved: boolean }>;
  proposal?: PlanProposal;
  digest?: Digest;
  approvals: Array<{ proposalId: Id; approvalId: Id; approvalDocumentDigest: Digest; reference: string; expiresAt: Timestamp; approvedAt: Timestamp; admittedTaskIds: Id[] }>;
  threatModels: BoundedThreatModel[];
  coverage: CoverageReconciliation;
}

export interface PlanLedger {
  readonly root: string;
  propose(input: PlanProposeInput): PlanProposeOutcome;
  read(runId: Id, proposalId?: Id): PlanReadResult;
  approve(input: { run: RunManifest; proposalDigest: Digest; document: unknown }): Promise<PlanApproveOutcome>;
  recordAdmission(input: { runId: Id; proposalId: Id; approvalDocumentDigest: Digest; taskIds: readonly Id[] }): { ok: true; record: PlanApprovalRecord } | { ok: false; code: string };
  recordCoverageResolution(input: unknown): { ok: true; resolution: PlanCoverageResolution; duplicate: boolean } | { ok: false; code: string; issues: PlanIssue[] };
  approvedCells(runId: Id): PlanCoverageCell[];
  coverage(runId: Id): CoverageReconciliation;
  threatModel(runId: Id): ThreatModelStore;
  rejections(runId: Id): PlanRejectionRecord[];
}

const listRecords = <T>(files: ControlFiles, kind: string, predicate: (record: T) => boolean, limit = MAX_RECORDS): T[] => {
  const directory = join(files.root, kind);
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  const records: T[] = [];
  for (const name of names.sort()) {
    if (records.length >= limit) break;
    if (!name.endsWith('.json')) continue;
    try {
      const record = files.read<T>(kind, name.slice(0, -5), 4 * 1024 * 1024);
      if (record && predicate(record)) records.push(record);
    } catch { /* an unreadable record is skipped, never trusted */ }
  }
  return records;
};

export function createPlanLedger(options: PlanLedgerOptions): PlanLedger {
  const files = new ControlFiles(options.controlRoot);
  const clock = options.clock ?? Date.now;
  const caps = options.caps ?? {};
  const maxProposals = options.maxProposalsPerRun ?? 32;
  const stores = new Map<Id, ThreatModelStore>();
  const authority = options.authority;

  const plans = (runId: Id): PlanRecord[] => listRecords<PlanRecord>(files, 'plans', record => record.version === 1 && record.runId === runId);
  const approvals = (runId: Id): PlanApprovalRecord[] => listRecords<PlanApprovalRecord>(files, 'plan-approvals', record => record.version === 1 && record.runId === runId);
  const resolutions = (runId: Id): PlanCoverageRecord[] => listRecords<PlanCoverageRecord>(files, 'plan-coverage', record => record.version === 1 && record.runId === runId);

  function requireRun(value: unknown): RunManifest {
    try { return runSchema.parse(value); }
    catch { return fail('plan-run-invalid', 'An admitted run manifest is required to bind a plan'); }
  }

  function reject(runId: Id, plannerAttemptId: Id, packetDigest: Digest, code: string, issues: PlanIssue[]): PlanProposeOutcome {
    const record: PlanRejectionRecord = { version: 1, runId, at: instant(clock), packetDigest, code, issues: issues.slice(0, 100), plannerAttemptId };
    try { files.write('plan-rejections', packetDigest, record, 512 * 1024); } catch { /* audit record is best effort; the rejection stands */ }
    return { ok: false, code, issues, packetDigest };
  }

  function threatModel(runId: Id): ThreatModelStore {
    let store = stores.get(runId);
    if (!store) {
      store = createThreatModelStore({ controlRoot: options.controlRoot, runId, clock, ...(options.threatModelCaps ? { caps: options.threatModelCaps } : {}), ...(options.threatModelOptions ?? {}) });
      stores.set(runId, store);
    }
    return store;
  }

  return Object.freeze({
    root: files.root,
    propose(input: PlanProposeInput): PlanProposeOutcome {
      const run = requireRun(input.run);
      let packetDigest: Digest;
      let provisional: PlanProposal;
      try {
        packetDigest = digestJson(input.packet);
        provisional = JSON.parse(canonicalJson(input.packet)) as PlanProposal;
      } catch {
        return reject(run.runId, input.plannerAttemptId, digestJson({ unparsable: true }), 'plan-not-json', [planIssue('plan-not-json', '$', 'Proposal packet is not a plain acyclic JSON document')]);
      }
      const rawProvenance = provisional.provenance;
      if (rawProvenance !== undefined && (rawProvenance === null || typeof rawProvenance !== 'object' || Array.isArray(rawProvenance))) {
        return reject(run.runId, input.plannerAttemptId, packetDigest, 'plan-schema', [planIssue('plan-schema', '$/provenance', 'Packet provenance must be a plain object')]);
      }
      const provenance = (rawProvenance ?? {}) as unknown as Record<string, unknown>;
      if (provenance.packetDigest !== undefined && provenance.packetDigest !== packetDigest) {
        return reject(run.runId, input.plannerAttemptId, packetDigest, 'plan-packet-digest', [planIssue('plan-packet-digest', '$/provenance/packetDigest', 'Recorded packet digest does not match the received packet')]);
      }
      if (provenance.plannerAttemptId === undefined) provenance.plannerAttemptId = input.plannerAttemptId;
      if (provenance.plannerKind === undefined) provenance.plannerKind = 'worker';
      if (provenance.requestedSelection === undefined && input.requestedSelection) provenance.requestedSelection = input.requestedSelection;
      if (provenance.inputDigests === undefined && input.inputDigests) provenance.inputDigests = [...input.inputDigests];
      if (provenance.producedAt === undefined) provenance.producedAt = input.producedAt ?? instant(clock);
      provenance.packetDigest = packetDigest;
      provisional.provenance = provenance as unknown as PlanProposal['provenance'];
      if (provenance.plannerAttemptId !== input.plannerAttemptId) {
        return reject(run.runId, input.plannerAttemptId, packetDigest, 'plan-attempt-mismatch', [planIssue('plan-attempt-mismatch', '$/provenance/plannerAttemptId', 'Packet provenance names a different planner attempt')]);
      }
      const issues = validatePlanProposalChecked(provisional, run, caps, input.caps);
      if (issues.length) return reject(run.runId, input.plannerAttemptId, packetDigest, issues[0]!.code, issues);
      const existing = plans(run.runId);
      if (existing.length >= maxProposals) {
        return reject(run.runId, input.plannerAttemptId, packetDigest, 'plan-proposal-limit', [planIssue('plan-proposal-limit', '$', `Run already holds ${existing.length} stored proposals`)]);
      }
      const digest = planProposalDigest(provisional);
      const same = existing.find(record => record.proposalId === provisional.proposalId);
      if (same && same.digest !== digest) {
        return reject(run.runId, input.plannerAttemptId, packetDigest, 'plan-proposal-conflict', [planIssue('plan-proposal-conflict', '$/proposalId', 'Proposal identity is already bound to different content')]);
      }
      if (same) return { ok: true, record: same };
      const record: PlanRecord = {
        version: 1, proposalId: provisional.proposalId, digest, runId: run.runId,
        proposal: provisional, storedAt: instant(clock), plannerAttemptId: input.plannerAttemptId,
      };
      files.write('plans', provisional.proposalId, record, 4 * 1024 * 1024);
      if (provisional.threatModel) {
        threatModel(run.runId).save({ targetKey: provisional.threatModel.targetKey, body: provisional.threatModel.body, attemptId: input.plannerAttemptId });
      }
      return { ok: true, record };
    },

    read(runId: Id, proposalId?: Id): PlanReadResult {
      const stored = proposalsFor(files, runId);
      const approved = approvals(runId);
      const approvedIds = new Set(approved.map(record => record.proposalId));
      const selected = proposalId === undefined ? undefined : stored.find(record => record.proposalId === proposalId);
      const cells = approvedCellsFor(stored, approved);
      const reconciliation = reconcileCoverage(cells, resolutions(runId).map(record => record.resolution), { runId });
      const models = listRecords<ThreatModel>(files, 'threat-models', model => model.runId === runId)
        .map(model => readThreatModelBounded(model, runId, model.targetKey));
      return {
        runId,
        proposals: stored.map(record => ({
          proposalId: record.proposalId, digest: record.digest, storedAt: record.storedAt, plannerAttemptId: record.plannerAttemptId,
          taskCount: record.proposal.tasks.length, observationCount: record.proposal.observations.length,
          coverageCount: record.proposal.coverage.length, approved: approvedIds.has(record.proposalId),
        })),
        ...(selected ? { proposal: selected.proposal, digest: selected.digest } : {}),
        approvals: approved.map(record => ({
          proposalId: record.proposalId, approvalId: record.approval.approvalId, approvalDocumentDigest: record.approvalDocumentDigest,
          reference: record.approval.reference, expiresAt: record.approval.expiresAt, approvedAt: record.approvedAt, admittedTaskIds: [...record.admittedTaskIds],
        })),
        threatModels: models,
        coverage: reconciliation,
      };
    },

    async approve(input: { run: RunManifest; proposalDigest: Digest; document: unknown }): Promise<PlanApproveOutcome> {
      const run = requireRun(input.run);
      const stored = proposalsFor(files, run.runId).find(record => record.digest === input.proposalDigest);
      if (!stored) return { ok: false, code: 'plan-unknown-proposal', issues: [planIssue('plan-unknown-proposal', '$/proposalDigest', 'No stored proposal matches this digest')] };
      const digest = planProposalDigest(stored.proposal);
      if (digest !== input.proposalDigest || digest !== stored.digest) {
        return { ok: false, code: 'plan-digest-mismatch', issues: [planIssue('plan-digest-mismatch', '$/proposalDigest', 'Stored proposal content no longer matches the approved digest')] };
      }
      const parsedDocument = planApprovalDocumentSchema.safeParse(input.document);
      if (!parsedDocument.success) {
        return { ok: false, code: 'plan-approval-invalid', issues: parsedDocument.issues.map(issue => planIssue('plan-approval-invalid', issue.path, `${issue.code}: ${issue.message}`)) };
      }
      const document = parsedDocument.data;
      if (document.proposalId !== stored.proposalId || document.proposalDigest !== digest || document.runId !== run.runId
        || document.taskCount !== stored.proposal.tasks.length || document.observationCount !== stored.proposal.observations.length) {
        return { ok: false, code: 'plan-approval-binding', issues: [planIssue('plan-approval-binding', '$', 'Approval document is not bound to this proposal, run, task count and observation count')] };
      }
      const now = instant(clock);
      if (!(Date.parse(document.expiresAt) > Date.parse(now))) {
        return { ok: false, code: 'plan-approval-expired', issues: [planIssue('plan-approval-expired', '$/expiresAt', 'Owner plan approval has expired')] };
      }
      if (Date.parse(document.approvedAt) > Date.parse(now)) {
        return { ok: false, code: 'plan-approval-future', issues: [planIssue('plan-approval-future', '$/approvedAt', 'Owner plan approval is future-dated')] };
      }
      const approvePlan = authority.approvePlan;
      if (!approvePlan) return { ok: false, code: 'plan-approval-unavailable', issues: [planIssue('plan-approval-unavailable', '$', 'This authority exposes no owner plan approval')] };
      let approval: PlanApproval;
      try {
        approval = await approvePlan.call(authority, stored.proposal, document, { runId: run.runId, now });
      } catch (error) {
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'plan-approval-denied';
        return { ok: false, code, issues: [planIssue(code, '$', error instanceof Error ? error.message : 'Owner plan approval denied')] };
      }
      const issues = validatePlanProposalChecked(stored.proposal, run, caps, undefined);
      if (issues.length) return { ok: false, code: issues[0]!.code, issues };
      const approvalDocumentDigest = digestJson(document);
      const existing = approvals(run.runId).find(record => record.proposalId === stored.proposalId);
      if (existing) {
        if (existing.approvalDocumentDigest !== approvalDocumentDigest) {
          return { ok: false, code: 'plan-approval-conflict', issues: [planIssue('plan-approval-conflict', '$', 'Proposal already has a different owner approval recorded')] };
        }
        return { ok: true, approval: existing.approval, document, proposal: stored.proposal, record: existing, duplicate: true };
      }
      const record: PlanApprovalRecord = {
        version: 1, runId: run.runId, proposalId: stored.proposalId, digest,
        approval, approvalDocumentDigest, approvedAt: now, admittedTaskIds: [],
      };
      files.write('plan-approvals', stored.proposalId, record, 2 * 1024 * 1024);
      return { ok: true, approval, document, proposal: stored.proposal, record, duplicate: false };
    },

    recordAdmission(input: { runId: Id; proposalId: Id; approvalDocumentDigest: Digest; taskIds: readonly Id[] }): { ok: true; record: PlanApprovalRecord } | { ok: false; code: string } {
      const existing = approvals(input.runId).find(record => record.proposalId === input.proposalId);
      if (!existing) return { ok: false, code: 'plan-unknown-approval' };
      if (existing.approvalDocumentDigest !== input.approvalDocumentDigest) return { ok: false, code: 'plan-admission-conflict' };
      const taskIds = [...new Set([...existing.admittedTaskIds, ...input.taskIds])].sort();
      const record: PlanApprovalRecord = { ...existing, admittedTaskIds: taskIds };
      files.write('plan-approvals', input.proposalId, record, 2 * 1024 * 1024);
      return { ok: true, record };
    },

    recordCoverageResolution(input: unknown): { ok: true; resolution: PlanCoverageResolution; duplicate: boolean } | { ok: false; code: string; issues: PlanIssue[] } {
      const parsed = planCoverageResolutionSchema.safeParse(input);
      if (!parsed.success) return { ok: false, code: 'coverage-invalid', issues: parsed.issues.map(issue => planIssue(`coverage-invalid`, issue.path, `${issue.code}: ${issue.message}`)) };
      const resolution = parsed.data;
      const planned = new Set(approvedCellsFor(proposalsFor(files, resolution.runId), approvals(resolution.runId)).map(cell => cell.cellId));
      if (!planned.has(resolution.cellId)) return { ok: false, code: 'coverage-unknown-cell', issues: [planIssue('coverage-unknown-cell', '$/cellId', 'Resolution targets a cell that no approved proposal planned')] };
      const digest = digestJson(resolution);
      const existing = files.read<PlanCoverageRecord>('plan-coverage', resolution.cellId, 1 * 1024 * 1024);
      if (existing) {
        if (existing.digest === digest) return { ok: true, resolution: existing.resolution, duplicate: true };
        return { ok: false, code: 'coverage-conflict', issues: [planIssue('coverage-conflict', '$/cellId', 'Coverage cell already has a different recorded resolution')] };
      }
      files.write('plan-coverage', resolution.cellId, { version: 1, runId: resolution.runId, cellId: resolution.cellId, digest, resolution } satisfies PlanCoverageRecord, 1 * 1024 * 1024);
      return { ok: true, resolution, duplicate: false };
    },

    approvedCells(runId: Id): PlanCoverageCell[] {
      return approvedCellsFor(plans(runId), approvals(runId));
    },

    coverage(runId: Id): CoverageReconciliation {
      return reconcileCoverage(approvedCellsFor(plans(runId), approvals(runId)), resolutions(runId).map(record => record.resolution), { runId });
    },

    threatModel,

    rejections(runId: Id): PlanRejectionRecord[] {
      return listRecords<PlanRejectionRecord>(files, 'plan-rejections', record => record.version === 1 && record.runId === runId);
    },
  }) satisfies PlanLedger;
}

/** All stored proposals for a run (not only approved ones); used by read and approval lookup. */
function proposalsFor(files: ControlFiles, runId: Id): PlanRecord[] {
  return listRecords<PlanRecord>(files, 'plans', record => record.version === 1 && record.runId === runId);
}

function approvedCellsFor(stored: PlanRecord[], approved: PlanApprovalRecord[]): PlanCoverageCell[] {
  const approvedIds = new Set(approved.map(record => record.proposalId));
  const cells = new Map<Id, PlanCoverageCell>();
  for (const record of stored) {
    if (!approvedIds.has(record.proposalId)) continue;
    for (const cell of record.proposal.coverage) if (!cells.has(cell.cellId)) cells.set(cell.cellId, cell);
  }
  return [...cells.values()];
}


function validatePlanProposalChecked(proposal: PlanProposal, run: RunManifest, ledgerCaps: Partial<PlanCaps>, callCaps?: Partial<PlanCaps>): PlanIssue[] {
  const ceiling: Partial<PlanCaps> = {};
  for (const field of ['maxTasks', 'maxDepth', 'maxObservations', 'maxRequests'] as const) {
    const values = [ledgerCaps[field], callCaps?.[field]].filter((value): value is number => value !== undefined);
    if (values.length) ceiling[field] = Math.min(...values);
  }
  return validatePlanProposal(proposal, { caps: ceiling, run });
}


// ---------------------------------------------------------------------------------------------
// Interface port: reads the planner packet / owner approval from disk and admits the approved batch.
// ---------------------------------------------------------------------------------------------

export interface PlanPortOptions {
  controlRoot: string;
  store: DurableStore;
  supervisor: SupervisorApi;
  authority: Authority;
  toolPolicy: ToolPolicy;
  boundaryReceipt: string;
  role?: Role;
  clock?: () => number;
  caps?: Partial<PlanCaps>;
  threatModelCaps?: Partial<ThreatModelCaps>;
  /**
   * Reuse a composition-owned ledger so propose/read/approve, the report coverage gate and the worker threat-model
   * context all read and write one durable state. Absent, the port owns a private ledger.
   */
  ledger?: PlanLedger;
  /**
   * Owner-document narrowing guard. Returns a bounded refusal message when a planned observation is not one the
   * owner document approved for that task, or when its declared binding is not covered by the owner-approved input.
   * Absent means the composition supplies no owner cross-check and accepts the proposal on its own validation.
   */
  observationApproved?(input: { taskId: Id; observationId: Id; tool: string; binding: JsonObject }): string | undefined;
  /** Prepare the private per-task workspace (bridge descriptor) before the supervisor admits the batch. */
  prepareWorkspace?(input: { taskId: Id; workspace: string }): void;
  /** Called after a successful batch admission with the exact materialized plan (never before admission). */
  onAdmitted?(materialized: MaterializedPlan): void;
}


export interface PlanPort {
  propose(input: { runId: Id; proposalPath: string }): Promise<unknown>;
  read(input: { runId: Id; proposalId?: Id }): Promise<unknown>;
  approve(input: { runId: Id; proposalDigest: Digest; approvalPath: string }): Promise<unknown>;
}

function readBoundedDocument(path: string, label: string, maxBytes: number, ownerOnly: boolean): unknown {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail('plan-path', `${label} must be a canonical absolute path`);
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); }
  catch { return fail('plan-path', `${label} does not exist or is not readable`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('plan-path', `${label} must be a regular file, not a link`);
  if (ownerOnly && (stat.mode & 0o022) !== 0) fail('plan-path', `${label} must not be group/world writable`);
  if (process.getuid && stat.uid !== process.getuid()) fail('plan-path', `${label} must be owned by the current user`);
  if (stat.size === 0 || stat.size > maxBytes) fail('plan-path', `${label} must be a non-empty file under ${maxBytes} bytes`);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fail('plan-path', `${label} is not valid JSON`); }
}

export function createPlanPort(options: PlanPortOptions): PlanPort {
  const ledger = options.ledger ?? createPlanLedger({
    controlRoot: options.controlRoot, authority: options.authority,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.caps ? { caps: options.caps } : {}),
    ...(options.threatModelCaps ? { threatModelCaps: options.threatModelCaps } : {}),
  });
  const requireRun = (runId: string): RunManifest => {
    const run = options.store.getRun(runId);
    if (!run) fail('plan-run-unknown', `No durable run ${runId}`);
    return run;
  };
  return Object.freeze({
    async propose(input: { runId: Id; proposalPath: string }): Promise<unknown> {
      const run = requireRun(input.runId);
      const packet = readBoundedDocument(input.proposalPath, 'proposal packet', MAX_PROPOSAL_BYTES, true);
      const provenance = (packet !== null && typeof packet === 'object' ? (packet as { provenance?: unknown }).provenance : undefined);
      const named = provenance !== null && typeof provenance === 'object' ? (provenance as { plannerAttemptId?: unknown }).plannerAttemptId : undefined;
      const plannerAttemptId = typeof named === 'string' && named.length > 0 ? named : `plan-${digestJson(packet).slice(0, 24)}`;
      const outcome = ledger.propose({ packet, run, plannerAttemptId });
      if (!outcome.ok) return { ok: false, runId: run.runId, code: outcome.code, issues: outcome.issues, packetDigest: outcome.packetDigest };
      return {
        ok: true, runId: run.runId, proposalId: outcome.record.proposalId, proposalDigest: outcome.record.digest,
        taskCount: outcome.record.proposal.tasks.length, observationCount: outcome.record.proposal.observations.length,
        coverageCount: outcome.record.proposal.coverage.length, storedAt: outcome.record.storedAt,
        note: 'Proposal stored and digest-computed; nothing is admitted until the owner approves this exact digest.',
      };
    },
    async read(input: { runId: Id; proposalId?: Id }): Promise<unknown> {
      const run = requireRun(input.runId);
      return ledger.read(run.runId, input.proposalId);
    },
    async approve(input: { runId: Id; proposalDigest: Digest; approvalPath: string }): Promise<unknown> {
      const run = requireRun(input.runId);
      const document = readBoundedDocument(input.approvalPath, 'owner plan approval', MAX_APPROVAL_BYTES, true);
      const outcome = await ledger.approve({ run, proposalDigest: input.proposalDigest, document });
      if (!outcome.ok) return { ok: false, runId: run.runId, code: outcome.code, issues: outcome.issues };
      const workspaceFor = options.supervisor.workspaceFor;
      if (!workspaceFor) fail('plan-workspace-unavailable', 'The supervisor does not expose a derived private workspace for plan materialization');
      const admitPlan = options.supervisor.admitPlan;
      if (!admitPlan) fail('plan-admission-unavailable', 'The supervisor does not expose approved-plan batch admission');
      const materialized = materializePlan(outcome.proposal, {
        run, approval: outcome.document, now: instant(options.clock), workspaceFor: taskId => workspaceFor.call(options.supervisor, taskId),
        ...(options.role ? { role: options.role } : {}),
      });
      // Owner-document narrowing guard: every planned observation must map to an owner-approved check for its task
      // and its declared binding must be covered by the owner-approved input. This never widens the owner document.
      if (options.observationApproved) {
        for (const check of materialized.checks) {
          const message = options.observationApproved({
            taskId: check.taskId, observationId: check.observationId, tool: check.tool,
            binding: JSON.parse(canonicalJson(check.input)) as JsonObject,
          });
          if (message) fail('plan-observation-unapproved', message);
        }
      }
      // The supervisor derives the private workspace; the composition's bridge descriptor must exist before launch.
      for (const task of materialized.tasks) options.prepareWorkspace?.({ taskId: task.manifest.taskId, workspace: task.manifest.workspace });
      const batch: PlanAdmissionBatch = {
        proposal: outcome.proposal, approval: outcome.document, tasks: materialized.tasks,
        toolPolicy: options.toolPolicy, boundaryReceipt: options.boundaryReceipt,
        ...(options.role ? { role: options.role } : {}),
      };
      const admitted = await admitPlan.call(options.supervisor, batch);
      ledger.recordAdmission({ runId: run.runId, proposalId: outcome.proposal.proposalId, approvalDocumentDigest: outcome.record.approvalDocumentDigest, taskIds: admitted.map(task => task.taskId) });
      options.onAdmitted?.(materialized);
      return {
        ok: true, runId: run.runId, proposalId: outcome.proposal.proposalId, proposalDigest: outcome.record.digest,
        approval: { approvalId: outcome.approval.approvalId, reference: outcome.approval.reference, expiresAt: outcome.approval.expiresAt, duplicate: outcome.duplicate },
        admittedTaskIds: admitted.map(task => task.taskId),
        observationCount: materialized.checks.length,
        coverageCellIds: materialized.coverageCells.map(cell => cell.cellId),
        coverage: ledger.coverage(run.runId),
      };
    },
  }) satisfies PlanPort;
}

// ---------------------------------------------------------------------------------------------
// Worker bridge context: bounded read + attributed, size-capped, rate-limited amend.
// ---------------------------------------------------------------------------------------------

export interface WorkerContextPortOptions {
  ledger: PlanLedger;
  runId: Id;
  /** Optional fixed target key; when absent the read returns every model for the run. */
  targetKey?: string;
  maxModels?: number;
}

export function createWorkerContextPort(options: WorkerContextPortOptions): WorkerContextPort {
  const store = (): ThreatModelStore => options.ledger.threatModel(options.runId);
  const bound = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;
  return Object.freeze({
    async read(_attempt: Readonly<AttemptRecord>, payload: unknown): Promise<unknown> {
      const selection = payload === undefined || payload === null ? {} : object(payload, ['targetKey'], 'threat-model read');
      const targetKey = selection.targetKey === undefined ? options.targetKey : text(selection.targetKey, 'targetKey', 2_048);
      if (targetKey) return bound(store().read(targetKey));
      const models = store().list()
        .filter(model => model.runId === options.runId)
        .slice(0, options.maxModels ?? 8)
        .map(model => readThreatModelBounded(model, options.runId, model.targetKey));
      return bound({ runId: options.runId, found: models.length > 0, models });
    },
    async amend(attempt: Readonly<AttemptRecord>, payload: unknown, _signal: AbortSignal): Promise<unknown> {
      const input = object(payload, ['targetKey', 'text'], 'threat-model amendment');
      const targetKey = text(input.targetKey, 'targetKey', 2_048);
      const body = text(input.text, 'text', threatModelCapsDefaults.maxAmendmentChars);
      const result = store().amend({ targetKey, attemptId: attempt.attemptId, text: body });
      return bound({ ...result, runId: options.runId, targetKey: normalizeTargetKey(targetKey) });
    },
  }) satisfies WorkerContextPort;
}

/** Strictly parse one worker amendment payload without touching the store. */
export function parseThreatModelAmendment(payload: unknown): { targetKey: string; text: string } {
  const input = object(payload, ['targetKey', 'text'], 'threat-model amendment');
  return { targetKey: text(input.targetKey, 'targetKey', 2_048), text: text(input.text, 'text', threatModelCapsDefaults.maxAmendmentChars) };
}

/** Re-exported for compositions that only need the bounded projection. */
export { readThreatModelBounded };

// ---------------------------------------------------------------------------------------------
// Generated request proposals: model-authored concrete http.request inputs, owner batch approval, materialization.
//
// This is deliberately separate from the plan path above. The model authors new paths/queries the owner checks
// never enumerated; the validator constrains each request to the owner's target/account/action/budget envelope;
// the proposal is sealed by its canonical digest; the owner grant's own copy of the approval document must
// match that exact digest; and only an approved proposal materializes into ObservationChecks plus per-check
// task grants. No request is dispatched by any function here: the caller decides when to execute a check.
// ---------------------------------------------------------------------------------------------

export interface RequestPlanMaterializationContext {
  run: RunManifest;
  /** Owner-gate output for this proposal; only `approveRequestProposal` produces it. */
  approval: PlanRequestApproval;
  /** The exact owner-authored document the gate approved; it must hash to the gate's document digest. */
  document: PlanRequestApprovalDocument;
  /** Controller-derived owner envelope, re-checked at materialization time so a narrowed/revoked scope cannot execute. */
  envelope: PlanRequestEnvelope;
  /** Owner task identity for claim/surface/actor binding; absent leaves those optional check fields empty. */
  taskFor?(taskId: Id): { question?: { text: string }; surfaceId?: Id; actorId?: Id } | undefined;
  now: Timestamp;
}

/**
 * Controller-issued grant for one materialized generated check. It records the exact approved request identity
 * (digest, URL digest, target, method, action, account, cost) so a composition can register the check without
 * re-deriving authority from model prose.
 */
export interface ApprovedRequestGrant {
  version: 1;
  grantId: Id;
  taskId: Id;
  checkId: Id;
  observationId: Id;
  requestId: Id;
  tool: 'http.request';
  action: 'read' | 'mutate';
  method: PlanRequestMethod;
  targetId: Id;
  accountId: Id;
  url: string;
  urlDigest: Digest;
  requests: number;
  proposalId: Id;
  proposalDigest: Digest;
  approvalId: Id;
  approvalDocumentDigest: Digest;
  approvedBy: string;
  expiresAt: Timestamp;
}

export interface MaterializedRequestPlan {
  proposalId: Id;
  digest: Digest;
  runId: Id;
  approvalId: Id;
  approvalDocumentDigest: Digest;
  checks: ObservationCheck[];
  grants: ApprovedRequestGrant[];
  taskIds: Id[];
}

/** Deterministic controller identity; a model-chosen requestId never becomes a check identity on its own. */
export function requestCheckId(proposalDigest: Digest, requestId: Id): Id {
  return `rchk-${digestJson({ kind: 'request-check', proposalDigest, requestId }).slice(0, 32)}`;
}
export function requestObservationId(proposalDigest: Digest, requestId: Id): Id {
  return `rob-${digestJson({ kind: 'request-observation', proposalDigest, requestId }).slice(0, 32)}`;
}
export function requestGrantId(proposalDigest: Digest, requestId: Id): Id {
  return `reqg-${digestJson({ kind: 'request-grant', proposalDigest, requestId }).slice(0, 32)}`;
}

/**
 * Pure gate: the exact approved proposal becomes checks and grants. It refuses any proposal whose bytes, run or
 * window do not match the owner document, and it re-validates against the owner envelope so a scope that was
 * narrowed or revoked after approval cannot execute. It never contacts the target.
 */
export function materializeRequestPlan(proposal: PlanRequestProposal, context: RequestPlanMaterializationContext): MaterializedRequestPlan {
  const parsed = planRequestProposalSchema.parse(proposal);
  const run = runSchema.parse(context.run);
  const digest = planRequestProposalDigest(parsed);
  const approval = context.approval;
  const document = planRequestApprovalDocumentSchema.parse(context.document);
  if (approval.allowed !== true || digestJson(document) !== approval.approvalDocumentDigest) {
    throw new ApplicationError('request-plan-approval-binding', 'The owner-gate approval does not match the presented approval document bytes');
  }
  if (approval.proposalDigest !== digest || approval.proposalId !== parsed.proposalId
    || document.proposalDigest !== digest || document.proposalId !== parsed.proposalId || document.runId !== run.runId) {
    throw new ApplicationError('request-plan-approval-binding', 'Approval document is not bound to this exact generated-request proposal and run');
  }
  if (!(Date.parse(document.expiresAt) > Date.parse(context.now))) {
    throw new ApplicationError('request-plan-approval-expired', 'Owner request approval has expired');
  }
  if (Date.parse(document.approvedAt) > Date.parse(context.now)) {
    throw new ApplicationError('request-plan-approval-future', 'Owner request approval is future-dated');
  }
  const issues = validatePlanRequestProposal(parsed, { run, envelope: context.envelope });
  if (issues.length) {
    const first = issues[0]!;
    throw new ApplicationError('request-plan-envelope-changed', `Proposal no longer satisfies the owner envelope: ${first.code}: ${first.message}`);
  }
  const taskGrants = new Map(context.envelope.taskGrants.map(grant => [grant.taskId, grant]));
  const checks: ObservationCheck[] = [];
  const grants: ApprovedRequestGrant[] = [];
  for (const draft of parsed.requests) {
    const taskGrant = taskGrants.get(draft.taskId)!;
    const binding = planRequestBinding({ url: draft.url, taskGrant, envelope: context.envelope })!;
    const checkId = requestCheckId(digest, draft.requestId);
    const observationId = requestObservationId(digest, draft.requestId);
    const task = context.taskFor?.(draft.taskId);
    checks.push({
      checkId, taskId: draft.taskId, observationId, tool: 'http.request',
      input: planRequestInput(draft),
      kind: draft.kind, classification: draft.classification, summary: draft.summary,
      ...(draft.expectation ? { expectation: draft.expectation } : {}),
      ...(task?.question ? { claim: task.question.text } : {}),
      ...(task?.surfaceId ? { surfaceId: task.surfaceId } : {}),
      ...(task?.actorId ? { actorId: task.actorId } : {}),
    });
    grants.push(Object.freeze({
      version: 1, grantId: requestGrantId(digest, draft.requestId), taskId: draft.taskId,
      checkId, observationId, requestId: draft.requestId, tool: 'http.request', action: draft.action,
      method: draft.method, targetId: binding.targetId, accountId: draft.accountId, url: draft.url,
      urlDigest: digestJson(draft.url), requests: draft.requests, proposalId: parsed.proposalId,
      proposalDigest: digest, approvalId: approval.approvalId, approvalDocumentDigest: approval.approvalDocumentDigest,
      approvedBy: approval.approvedBy, expiresAt: approval.expiresAt,
    }));
  }
  return Object.freeze({
    proposalId: parsed.proposalId, digest, runId: run.runId, approvalId: approval.approvalId,
    approvalDocumentDigest: approval.approvalDocumentDigest, checks, grants,
    taskIds: [...new Set(parsed.requests.map(draft => draft.taskId))].sort(),
  });
}

export interface RequestPlanLedgerOptions {
  controlRoot: string;
  /** Owner gate holding the owner's own approved-document copies. An empty list approves nothing. */
  authority: RequestApprovalAuthority;
  clock?: () => number;
  caps?: Partial<PlanRequestCaps>;
  maxProposalsPerRun?: number;
}

export interface RequestPlanProposeInput {
  packet: unknown;
  run: RunManifest;
  envelope: PlanRequestEnvelope;
  generatorAttemptId: Id;
  generatorKind?: 'scripted' | 'worker';
  requestedSelection?: RuntimeSelection;
  inputDigests?: Digest[];
  producedAt?: Timestamp;
  caps?: Partial<PlanRequestCaps>;
}

export type RequestPlanProposeOutcome =
  | { ok: true; record: RequestPlanRecord }
  | { ok: false; code: string; issues: PlanIssue[]; packetDigest: Digest };

export type RequestPlanApproveOutcome =
  | { ok: true; approval: PlanRequestApproval; document: PlanRequestApprovalDocument; proposal: PlanRequestProposal; record: RequestPlanApprovalRecord; duplicate: boolean }
  | { ok: false; code: string; issues: PlanIssue[] };

export type RequestPlanMaterializeOutcome =
  | { ok: true; proposal: PlanRequestProposal; digest: Digest; document: PlanRequestApprovalDocument; plan: MaterializedRequestPlan }
  | { ok: false; code: string; issues: PlanIssue[] };

export interface RequestPlanRecord extends StoredPlanRequestProposal { version: 1 }

export interface RequestPlanApprovalRecord {
  version: 1;
  runId: Id;
  proposalId: Id;
  digest: Digest;
  approval: PlanRequestApproval;
  /** The exact owner-authored document; materialization re-checks its binding and window. */
  document: PlanRequestApprovalDocument;
  approvalDocumentDigest: Digest;
  approvedAt: Timestamp;
  requestCount: number;
}

interface RequestPlanRejectionRecord {
  version: 1; runId: Id; at: Timestamp; packetDigest: Digest; code: string; issues: PlanIssue[]; generatorAttemptId: Id;
}

export interface RequestPlanReadResult {
  runId: Id;
  proposals: Array<{ proposalId: Id; digest: Digest; storedAt: Timestamp; generatorAttemptId: Id; requestCount: number; approved: boolean }>;
  proposal?: PlanRequestProposal;
  digest?: Digest;
  approvals: Array<{ proposalId: Id; approvalId: Id; approvalDocumentDigest: Digest; reference: string; expiresAt: Timestamp; approvedAt: Timestamp; requestCount: number }>;
}

export interface RequestPlanLedger {
  readonly root: string;
  propose(input: RequestPlanProposeInput): RequestPlanProposeOutcome;
  read(runId: Id, proposalId?: Id): RequestPlanReadResult;
  approve(input: { run: RunManifest; proposalDigest: Digest; document: unknown }): Promise<RequestPlanApproveOutcome>;
  /** Materialize one stored+approved proposal into checks/grants; refuses anything unapproved. Never dispatches. */
  materialize(input: { run: RunManifest; proposalDigest: Digest; envelope: PlanRequestEnvelope; taskFor?(taskId: Id): { question?: { text: string }; surfaceId?: Id; actorId?: Id } | undefined; now?: Timestamp }): RequestPlanMaterializeOutcome;
  rejections(runId: Id): RequestPlanRejectionRecord[];
}

function validateRequestProposalChecked(proposal: PlanRequestProposal, run: RunManifest, envelope: PlanRequestEnvelope, ledgerCaps: Partial<PlanRequestCaps>, callCaps?: Partial<PlanRequestCaps>): PlanIssue[] {
  const ceiling: Partial<PlanRequestCaps> = {};
  for (const field of ['maxRequests', 'maxProposals'] as const) {
    const values = [ledgerCaps[field], callCaps?.[field]].filter((value): value is number => value !== undefined);
    if (values.length) ceiling[field] = Math.min(...values);
  }
  return validatePlanRequestProposal(proposal, { run, envelope, caps: ceiling });
}

export function createRequestPlanLedger(options: RequestPlanLedgerOptions): RequestPlanLedger {
  const files = new ControlFiles(options.controlRoot);
  const clock = options.clock ?? Date.now;
  const caps = options.caps ?? {};
  const maxProposals = options.maxProposalsPerRun ?? planRequestCapsDefaults.maxProposals;
  const authority = options.authority;
  if (!authority || typeof authority.approveRequestProposal !== 'function') fail('invalid-grant', 'A request approval authority is required');

  const records = (runId: Id): RequestPlanRecord[] => listRecords<RequestPlanRecord>(files, 'request-plans', record => record.version === 1 && record.runId === runId);
  const approvalRecords = (runId: Id): RequestPlanApprovalRecord[] => listRecords<RequestPlanApprovalRecord>(files, 'request-approvals', record => record.version === 1 && record.runId === runId);

  function requireRun(value: unknown): RunManifest {
    const parsed = runSchema.safeParse(value);
    if (!parsed.success) fail('request-plan-run-invalid', `An admitted run manifest is required to bind generated requests: ${parsed.issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`);
    return parsed.data;
  }
  function requireEnvelope(value: unknown): PlanRequestEnvelope {
    const parsed = planRequestEnvelopeSchema.safeParse(value);
    if (!parsed.success) fail('request-plan-envelope-invalid', `A controller-derived owner request envelope is required: ${parsed.issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`);
    return parsed.data;
  }
  function reject(runId: Id, generatorAttemptId: Id, packetDigest: Digest, code: string, issues: PlanIssue[]): RequestPlanProposeOutcome {
    const record: RequestPlanRejectionRecord = { version: 1, runId, at: instant(clock), packetDigest, code, issues: issues.slice(0, 100), generatorAttemptId };
    try { files.write('request-rejections', packetDigest, record, 512 * 1024); } catch { /* audit record is best effort; the rejection stands */ }
    return { ok: false, code, issues, packetDigest };
  }

  return Object.freeze({
    root: files.root,
    propose(input: RequestPlanProposeInput): RequestPlanProposeOutcome {
      const run = requireRun(input.run);
      const envelope = requireEnvelope(input.envelope);
      let packetDigest: Digest;
      let provisional: PlanRequestProposal;
      try {
        packetDigest = digestJson(input.packet);
        provisional = JSON.parse(canonicalJson(input.packet)) as PlanRequestProposal;
      } catch {
        return reject(run.runId, input.generatorAttemptId, digestJson({ unparsable: true }), 'request-plan-not-json', [planIssue('request-plan-not-json', '$', 'Proposal packet is not a plain acyclic JSON document')]);
      }
      const rawGenerator = provisional.generator;
      if (rawGenerator !== undefined && (rawGenerator === null || typeof rawGenerator !== 'object' || Array.isArray(rawGenerator))) {
        return reject(run.runId, input.generatorAttemptId, packetDigest, 'request-plan-schema', [planIssue('request-plan-schema', '$/generator', 'Packet generator must be a plain object')]);
      }
      const generator = (rawGenerator ?? {}) as unknown as Record<string, unknown>;
      if (generator.packetDigest !== undefined && generator.packetDigest !== packetDigest) {
        return reject(run.runId, input.generatorAttemptId, packetDigest, 'request-plan-packet-digest', [planIssue('request-plan-packet-digest', '$/generator/packetDigest', 'Recorded packet digest does not match the received packet')]);
      }
      if (generator.generatorAttemptId === undefined) generator.generatorAttemptId = input.generatorAttemptId;
      if (generator.generatorKind === undefined) generator.generatorKind = input.generatorKind ?? 'worker';
      if (generator.requestedSelection === undefined && input.requestedSelection) generator.requestedSelection = input.requestedSelection;
      if (generator.inputDigests === undefined && input.inputDigests) generator.inputDigests = [...input.inputDigests];
      if (generator.producedAt === undefined) generator.producedAt = input.producedAt ?? instant(clock);
      generator.packetDigest = packetDigest;
      provisional.generator = generator as unknown as PlanRequestGenerator;
      if (generator.generatorAttemptId !== input.generatorAttemptId) {
        return reject(run.runId, input.generatorAttemptId, packetDigest, 'request-plan-attempt-mismatch', [planIssue('request-plan-attempt-mismatch', '$/generator/generatorAttemptId', 'Packet generator names a different attempt')]);
      }
      const issues = validateRequestProposalChecked(provisional, run, envelope, caps, input.caps);
      if (issues.length) return reject(run.runId, input.generatorAttemptId, packetDigest, issues[0]!.code, issues);
      const existing = records(run.runId);
      if (existing.length >= maxProposals) {
        return reject(run.runId, input.generatorAttemptId, packetDigest, 'request-plan-proposal-limit', [planIssue('request-plan-proposal-limit', '$', `Run already holds ${existing.length} stored generated-request proposals`)]);
      }
      const digest = planRequestProposalDigest(provisional);
      const same = existing.find(record => record.proposalId === provisional.proposalId);
      if (same && same.digest !== digest) {
        return reject(run.runId, input.generatorAttemptId, packetDigest, 'request-plan-proposal-conflict', [planIssue('request-plan-proposal-conflict', '$/proposalId', 'Proposal identity is already bound to different content')]);
      }
      if (same) return { ok: true, record: same };
      const record: RequestPlanRecord = {
        version: 1, proposalId: provisional.proposalId, digest, runId: run.runId,
        proposal: provisional, storedAt: instant(clock), generatorAttemptId: input.generatorAttemptId,
      };
      files.write('request-plans', provisional.proposalId, record, 1 * 1024 * 1024);
      return { ok: true, record };
    },

    read(runId: Id, proposalId?: Id): RequestPlanReadResult {
      const stored = records(runId);
      const approved = approvalRecords(runId);
      const approvedIds = new Set(approved.map(record => record.proposalId));
      const selected = proposalId === undefined ? undefined : stored.find(record => record.proposalId === proposalId);
      return {
        runId,
        proposals: stored.map(record => ({
          proposalId: record.proposalId, digest: record.digest, storedAt: record.storedAt,
          generatorAttemptId: record.generatorAttemptId, requestCount: record.proposal.requests.length,
          approved: approvedIds.has(record.proposalId),
        })),
        ...(selected ? { proposal: selected.proposal, digest: selected.digest } : {}),
        approvals: approved.map(record => ({
          proposalId: record.proposalId, approvalId: record.approval.approvalId,
          approvalDocumentDigest: record.approvalDocumentDigest, reference: record.approval.reference,
          expiresAt: record.approval.expiresAt, approvedAt: record.approvedAt, requestCount: record.requestCount,
        })),
      };
    },

    async approve(input: { run: RunManifest; proposalDigest: Digest; document: unknown }): Promise<RequestPlanApproveOutcome> {
      const run = requireRun(input.run);
      const stored = records(run.runId).find(record => record.digest === input.proposalDigest);
      if (!stored) return { ok: false, code: 'request-plan-unknown-proposal', issues: [planIssue('request-plan-unknown-proposal', '$/proposalDigest', 'No stored generated-request proposal matches this digest')] };
      const digest = planRequestProposalDigest(stored.proposal);
      if (digest !== input.proposalDigest || digest !== stored.digest) {
        return { ok: false, code: 'request-plan-digest-mismatch', issues: [planIssue('request-plan-digest-mismatch', '$/proposalDigest', 'Stored proposal content no longer matches the approved digest')] };
      }
      const parsedDocument = planRequestApprovalDocumentSchema.safeParse(input.document);
      if (!parsedDocument.success) {
        return { ok: false, code: 'request-plan-approval-invalid', issues: parsedDocument.issues.map(issue => planIssue('request-plan-approval-invalid', issue.path, `${issue.code}: ${issue.message}`)) };
      }
      const document = parsedDocument.data;
      if (document.proposalId !== stored.proposalId || document.proposalDigest !== digest || document.runId !== run.runId
        || document.requestCount !== stored.proposal.requests.length) {
        return { ok: false, code: 'request-plan-approval-binding', issues: [planIssue('request-plan-approval-binding', '$', 'Approval document is not bound to this proposal, run and request count')] };
      }
      const now = instant(clock);
      if (!(Date.parse(document.expiresAt) > Date.parse(now))) {
        return { ok: false, code: 'request-plan-approval-expired', issues: [planIssue('request-plan-approval-expired', '$/expiresAt', 'Owner request approval has expired')] };
      }
      if (Date.parse(document.approvedAt) > Date.parse(now)) {
        return { ok: false, code: 'request-plan-approval-future', issues: [planIssue('request-plan-approval-future', '$/approvedAt', 'Owner request approval is future-dated')] };
      }
      let approval: PlanRequestApproval;
      try {
        approval = await authority.approveRequestProposal(stored.proposal, document, { runId: run.runId, now, authorizationRef: run.authorization.reference });
      } catch (error) {
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'request-plan-approval-denied';
        return { ok: false, code, issues: [planIssue(code, '$', error instanceof Error ? error.message : 'Owner request approval denied')] };
      }
      const approvalDocumentDigest = digestJson(document);
      const existing = approvalRecords(run.runId).find(record => record.proposalId === stored.proposalId);
      if (existing) {
        if (existing.approvalDocumentDigest !== approvalDocumentDigest) {
          return { ok: false, code: 'request-plan-approval-conflict', issues: [planIssue('request-plan-approval-conflict', '$', 'Proposal already has a different owner approval recorded')] };
        }
        return { ok: true, approval: existing.approval, document, proposal: stored.proposal, record: existing, duplicate: true };
      }
      const record: RequestPlanApprovalRecord = {
        version: 1, runId: run.runId, proposalId: stored.proposalId, digest, approval, document,
        approvalDocumentDigest, approvedAt: now, requestCount: stored.proposal.requests.length,
      };
      files.write('request-approvals', stored.proposalId, record, 1 * 1024 * 1024);
      return { ok: true, approval, document, proposal: stored.proposal, record, duplicate: false };
    },

    materialize(input: { run: RunManifest; proposalDigest: Digest; envelope: PlanRequestEnvelope; taskFor?(taskId: Id): { question?: { text: string }; surfaceId?: Id; actorId?: Id } | undefined; now?: Timestamp }): RequestPlanMaterializeOutcome {
      const run = requireRun(input.run);
      const stored = records(run.runId).find(record => record.digest === input.proposalDigest);
      if (!stored) return { ok: false, code: 'request-plan-unknown-proposal', issues: [planIssue('request-plan-unknown-proposal', '$/proposalDigest', 'No stored generated-request proposal matches this digest')] };
      const record = approvalRecords(run.runId).find(candidate => candidate.proposalId === stored.proposalId && candidate.digest === stored.digest);
      if (!record) return { ok: false, code: 'request-plan-unapproved', issues: [planIssue('request-plan-unapproved', '$/proposalDigest', 'This proposal has no owner approval; generated requests never execute unapproved')] };
      let envelope: PlanRequestEnvelope;
      try { envelope = requireEnvelope(input.envelope); }
      catch (error) {
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'request-plan-envelope-invalid';
        return { ok: false, code, issues: [planIssue(code, '$/envelope', error instanceof Error ? error.message : 'Owner request envelope is invalid')] };
      }
      try {
        const plan = materializeRequestPlan(stored.proposal, {
          run, approval: record.approval, document: record.document, envelope, now: input.now ?? instant(clock),
          ...(input.taskFor ? { taskFor: input.taskFor } : {}),
        });
        return { ok: true, proposal: stored.proposal, digest: stored.digest, document: record.document, plan };
      } catch (error) {
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'request-plan-materialize-failed';
        return { ok: false, code, issues: [planIssue(code, '$', error instanceof Error ? error.message : 'Generated-request materialization failed')] };
      }
    },

    rejections(runId: Id): RequestPlanRejectionRecord[] {
      return listRecords<RequestPlanRejectionRecord>(files, 'request-rejections', record => record.version === 1 && record.runId === runId);
    },
  }) satisfies RequestPlanLedger;
}
