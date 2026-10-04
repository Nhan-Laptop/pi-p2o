import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planProposalDigest, type PlanApprovalDocument, type PlanProposal, type RunManifest, type StoredPlanProposal,
} from '../../src/contracts/index.js';
import { createOwnerAuthority } from '../../src/application/authority.js';
import { createPlanLedger, materializePlan, type MaterializedPlan, type PlanLedger } from '../../src/application/planner.js';
import { createSupervisor, type PlanAdmissionBatch, type RunAdmission, type Supervisor } from '../../src/orchestrator/index.js';
import { openStore, type DurableStore } from '../../src/store/index.js';
import { ManualClock, fixtureRun, fixtureScope } from '../orchestrator/fixtures.js';

export const NOW = '2026-10-02T10:00:00.000Z';
export const PLAN_DEADLINE = '2026-10-02T11:29:00.000Z';
export const PLAN_APPROVAL_EXPIRY = '2026-10-02T11:45:00.000Z';
export const TOOL_POLICY: PlanAdmissionBatch['toolPolicy'] = { mode: 'trusted-fixture', allowUnsandboxedHostTools: true, tools: [] };
export const BOUNDARY = 'inert local fixture; no host tools; not a process sandbox';

/** One bounded, non-widening plan proposal over the orchestrator fixture run. */
export function planProposal(run: RunManifest, overrides: Partial<PlanProposal> = {}): PlanProposal {
  const question = {
    text: 'Does the local handler enforce its bounded input invariant?',
    ifTrue: 'Malformed local input is rejected before the handler',
    ifFalse: 'Malformed local input reaches the handler',
  };
  return {
    schemaVersion: 1,
    proposalId: 'plan-1',
    run: {
      runId: run.runId,
      purpose: 'Confirm the local input guard before any dynamic work',
      inputRevision: 'r1',
      scope: fixtureScope(run),
      targets: [{ id: 'fixture', kind: 'artifact', locator: 'fixtures/input.ts' }],
      accounts: [],
      allowedCapabilities: ['source.read'],
      allowedActions: ['review'],
      budgets: {
        deadlineAt: PLAN_DEADLINE, maxRequests: 5, maxBytes: 100_000, maxToolCalls: 20, maxTokens: 2_000,
        maxCostUsd: 2, maxAttempts: 3, maxTasks: 8, maxDepth: 3, maxConcurrency: 3,
      },
    },
    tasks: [{
      taskId: 'task-1', question, surfaceId: 'input-handler', surface: 'fixtures/input.ts#handler',
      actor: { id: 'local-reader', privileges: ['read-only'] },
      targetIds: ['fixture'], skills: ['static-review'], allowedActions: ['review'],
      requiredCapabilities: ['source.read'], dependencies: [], priority: 'high', depth: 0,
    }],
    observations: [{
      observationId: 'obs-1', taskId: 'task-1', tool: 'source.read', input: { path: 'fixtures/input.ts' },
      expectation: { type: 'source', contains: 'guard' }, kind: 'source', classification: 'static-inference',
      summary: 'Read the bounded fixture guard', requests: 1,
    }],
    coverage: [{
      cellId: 'cell-1', taskId: 'task-1', surfaceId: 'input-handler',
      actorId: 'local-reader', question: question.text, riskArea: 'input validation',
    }],
    caps: { maxTasks: 4, maxDepth: 2, maxObservations: 4, maxRequests: 4 },
    provenance: {
      plannerAttemptId: 'planner-1', plannerKind: 'scripted',
      requestedSelection: { ...run.requestedRuntime.selection },
      inputDigests: ['a'.repeat(64)], producedAt: NOW,
    },
    ...overrides,
  };
}

export function approvalDocument(proposal: PlanProposal, overrides: Partial<PlanApprovalDocument> = {}): PlanApprovalDocument {
  return {
    version: 1, approvalId: 'approval-1', proposalId: proposal.proposalId,
    proposalDigest: planProposalDigest(proposal), runId: proposal.run.runId,
    approvedBy: 'fixture-owner', reference: 'owner-plan-approval-1', approvedAt: NOW,
    expiresAt: PLAN_APPROVAL_EXPIRY, taskCount: proposal.tasks.length, observationCount: proposal.observations.length,
    ...overrides,
  };
}

export interface PlanHarness {
  root: string;
  controlRoot: string;
  workspaceRoot: string;
  store: DurableStore;
  clock: ManualClock;
  run: RunManifest;
  runAdmission: RunAdmission;
  /** The exact normalized proposal stored by the ledger (provenance.packetDigest injected). */
  proposal: PlanProposal;
  stored: StoredPlanProposal;
  digest: string;
  approvalDocument: PlanApprovalDocument;
  materialized: MaterializedPlan;
  authority: ReturnType<typeof createOwnerAuthority>;
  supervisor: Supervisor;
  ledger: PlanLedger;
  batch(): PlanAdmissionBatch;
}

/** Propose a packet first, then build the owner grant around its exact digest (as production must). */
export async function createPlanHarness(options: { packet?: PlanProposal; grantPlanApproval?: boolean } = {}): Promise<PlanHarness> {
  const root = mkdtempSync(join(tmpdir(), 'p2o-planner-'));
  const controlRoot = join(root, 'control');
  const workspaceRoot = join(root, 'workspaces');
  const clock = new ManualClock();
  const run = fixtureRun();
  const runAdmission: RunAdmission = { manifest: run, mode: 'managed', perTargetConcurrency: { fixture: 2 } };
  const store = openStore({ path: join(root, 'run.sqlite'), clock: () => NOW });
  const bootstrap = createOwnerAuthority({ version: 1, runs: [runAdmission], tasks: [] });
  const bootstrapLedger = createPlanLedger({ controlRoot, authority: bootstrap, clock: () => clock.now() });
  const packet = options.packet ?? planProposal(run);
  const outcome = bootstrapLedger.propose({ packet, run, plannerAttemptId: 'planner-1' });
  if (!outcome.ok) throw new Error(`fixture proposal was rejected: ${outcome.code} ${outcome.issues.map(issue => issue.message).join('; ')}`);
  const stored = outcome.record;
  const digest = stored.digest;
  const document = approvalDocument(stored.proposal);
  const authority = createOwnerAuthority({
    version: 1, runs: [runAdmission], tasks: [],
    ...(options.grantPlanApproval === false ? {} : { planApprovals: [document] }),
  });
  const supervisor = createSupervisor({
    store, authority, controlRoot, workspaceRoot, runtimes: {}, clock,
    ownerId: 'supervisor-a', reviewerId: 'reviewer-1', automatic: false,
    pollMs: 25, leaseMs: 120_000, startupTimeoutMs: 2_000, operationTimeoutMs: 2_000, stopReserveMs: 500,
  });
  await supervisor.admitRun(runAdmission);
  const ledger = createPlanLedger({ controlRoot, authority, clock: () => clock.now() });
  const materialized = materializePlan(stored.proposal, {
    run, approval: document, now: NOW, workspaceFor: taskId => supervisor.workspaceFor(taskId),
  });
  return {
    root, controlRoot, workspaceRoot, store, clock, run, runAdmission,
    proposal: stored.proposal, stored, digest, approvalDocument: document, materialized,
    authority, supervisor, ledger,
    batch: (): PlanAdmissionBatch => ({
      proposal: stored.proposal, approval: document, tasks: materialized.tasks,
      toolPolicy: TOOL_POLICY, boundaryReceipt: BOUNDARY,
    }),
  };
}

/** Fresh supervisor over the same durable store/control root, simulating a crash/restart replay. */
export function restartSupervisor(harness: PlanHarness): Supervisor {
  return createSupervisor({
    store: harness.store, authority: harness.authority, controlRoot: harness.controlRoot, workspaceRoot: harness.workspaceRoot,
    runtimes: {}, clock: harness.clock, ownerId: 'supervisor-b', reviewerId: 'reviewer-1', automatic: false,
    pollMs: 25, leaseMs: 120_000, startupTimeoutMs: 2_000, operationTimeoutMs: 2_000, stopReserveMs: 500,
  });
}

export { fixtureScope };
