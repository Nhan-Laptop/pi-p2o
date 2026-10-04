import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  digestJson, type EvidenceReceipt, type H2Details, type HandoffPacket, type ObservedRuntime,
  type RequestedRuntime, type RunManifest, type Scope, type TaskManifest, type TestReceipt,
} from '../../src/contracts/index.js';
import { openStore, type DurableStore, type ResultAdmission } from '../../src/store/index.js';
import {
  createSupervisor, type Approval, type Authority, type Clock, type ControlApproval, type ControlTransfer,
  type ModelSwitchRequest, type ReplacementApproval, type ReplacementProposal, type Role, type RunAdmission,
  type SubtaskRequest, type Supervisor, type SupervisorOptions,
  type TaskApproval, type TaskProposal,
} from '../../src/orchestrator/index.js';
import { FakeRuntime, type FakeRuntimeOptions } from './fake-runtime.js';

export const NOW = '2026-10-02T10:00:00.000Z';
export const START_MS = Date.parse(NOW);
export const HASH = 'a'.repeat(64);
export const BUILD_HASH = 'b'.repeat(64);
export const CONFIG_HASH = 'c'.repeat(64);
export const RUN_DEADLINE = '2026-10-02T11:30:00.000Z';
export const TASK_DEADLINE = '2026-10-02T11:00:00.000Z';
export const AUTHORIZATION_EXPIRY = '2026-10-02T12:00:00.000Z';

export class ManualClock implements Clock {
  private timers: Array<{ at: number; callback: () => void }> = [];
  constructor(public current: number = START_MS) {}
  now(): number { return this.current; }
  iso(): string { return new Date(this.current).toISOString(); }
  advance(ms: number): void { this.current += ms; }
  runDue(): number {
    const due = this.timers.filter(timer => timer.at <= this.current);
    this.timers = this.timers.filter(timer => timer.at > this.current);
    for (const timer of due) timer.callback();
    return due.length;
  }
  setTimeout(callback: () => void, ms: number): unknown {
    const entry = { at: this.current + ms, callback };
    this.timers.push(entry);
    return entry;
  }
  clearTimeout(timer: unknown): void { this.timers = this.timers.filter(candidate => candidate !== timer); }
  get pending(): number { return this.timers.length; }
}

export class FakeAuthority implements Authority {
  calls: string[] = [];
  denyRun: string | undefined;
  denyTask: string | undefined;
  denyReplacement: string | undefined;
  denyModelSwitch: string | undefined;
  /** Optional owner gate under test: set to undefined to emulate an authority without switch support. */
  approveModelSwitch?: Authority['approveModelSwitch'];
  denyTransfer = false;
  transferFenced = true;
  /** Owner-approval expiry override; defaults to the authorization expiry. */
  approvalExpiresAt: string | undefined;
  toolPolicy: unknown = { mode: 'trusted-fixture', allowUnsandboxedHostTools: true, tools: [] };
  boundaryReceipt = 'inert trusted local fixture; no host tools; not a process sandbox';
  private sequence = 0;
  constructor() {
    this.approveModelSwitch = async (proposal, run) => {
      this.calls.push('approveModelSwitch');
      return {
        allowed: this.denyModelSwitch === undefined, digest: digestJson(proposal),
        authorizationRef: run.authorization.reference, approvedBy: run.authorization.authorizedBy,
        reference: this.denyModelSwitch ?? `owner-switch-approval-${++this.sequence}`,
        expiresAt: this.approvalExpiresAt ?? run.authorization.expiresAt, attemptId: proposal.attemptId,
      };
    };
  }
  async verifyRun(proposal: RunAdmission): Promise<Approval> {
    this.calls.push('verifyRun');
    const run = proposal.manifest;
    return {
      allowed: this.denyRun === undefined, digest: digestJson(proposal), authorizationRef: run.authorization.reference,
      approvedBy: run.authorization.authorizedBy, reference: this.denyRun ?? `owner-run-approval-${++this.sequence}`,
      expiresAt: this.approvalExpiresAt ?? run.authorization.expiresAt,
    };
  }
  async approveTask(proposal: TaskProposal, run: RunManifest): Promise<TaskApproval> {
    this.calls.push('approveTask');
    return {
      allowed: this.denyTask === undefined, digest: digestJson(proposal), authorizationRef: run.authorization.reference,
      approvedBy: run.authorization.authorizedBy, reference: this.denyTask ?? `owner-task-approval-${++this.sequence}`,
      expiresAt: this.approvalExpiresAt ?? run.authorization.expiresAt, toolPolicy: this.toolPolicy as TaskApproval['toolPolicy'],
      boundaryReceipt: this.boundaryReceipt,
    };
  }
  async approveReplacement(proposal: ReplacementProposal, run: RunManifest): Promise<ReplacementApproval> {
    this.calls.push('approveReplacement');
    return {
      allowed: this.denyReplacement === undefined, digest: digestJson(proposal), authorizationRef: run.authorization.reference,
      approvedBy: run.authorization.authorizedBy, reference: this.denyReplacement ?? `owner-replacement-approval-${++this.sequence}`,
      expiresAt: this.approvalExpiresAt ?? run.authorization.expiresAt, parentAttemptId: proposal.attemptId,
    };
  }
  async transferControl(proposal: ControlTransfer): Promise<ControlApproval> {
    this.calls.push('transferControl');
    return {
      allowed: !this.denyTransfer, digest: digestJson(proposal),
      reference: `owner-control-transfer-${++this.sequence}`, previousControllerFenced: this.transferFenced as true,
    };
  }
}

/** A compliant discovered-subtask request derived from an already admitted parent task. */
export function subtaskRequest(parent: TaskManifest, overrides: Partial<SubtaskRequest> = {}): SubtaskRequest {
  return {
    question: {
      text: 'Does the second local branch reuse the same input guard?',
      ifTrue: 'The second branch rejects malformed local input',
      ifFalse: 'The second branch reaches the handler with malformed input',
    },
    targetIds: [...parent.scope.targetIds],
    actor: { id: parent.scope.actor.id, privileges: [...parent.scope.actor.privileges] },
    inputRevision: parent.inputRevision,
    role: 'worker',
    reason: 'the first branch exposed a second reachable path',
    ...overrides,
  };
}
/** One narrow, non-widening model switch request inside the fixture run profile. */
export function modelSwitch(model: string, thinking: ModelSwitchRequest['selection']['thinking'] = 'high'): ModelSwitchRequest {
  return { selection: { provider: 'fixture-provider', model, thinking }, reason: 'the first model stalled on the local branch' };
}

export function fixtureRun(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schemaVersion: 1, runId: 'run-1', createdAt: '2026-10-02T09:59:00.000Z', state: 'active',
    authorization: {
      reference: 'owner-approved-local-fixture', authorizedBy: 'fixture-owner',
      validFrom: '2026-10-02T09:00:00.000Z', expiresAt: AUTHORIZATION_EXPIRY,
      targets: [{ id: 'fixture', kind: 'artifact', locator: 'fixtures/input.ts', digest: HASH, revision: 'r1' }],
      exclusions: [], allowedActions: ['review', 'local-test', 'mutate'],
    },
    budgets: {
      deadlineAt: RUN_DEADLINE, maxRequests: 10, maxBytes: 1_000_000, maxToolCalls: 100, maxTokens: 10_000,
      maxCostUsd: 10, maxAttempts: 3, maxTasks: 8, maxDepth: 3, maxConcurrency: 3, reportReserveMs: 60_000,
      targetRequestLimits: { fixture: 5 },
    },
    requestedRuntime: {
      adapter: 'headless', selection: { provider: 'fixture-provider', model: 'fixture-model', thinking: 'max' },
      requiredCapabilities: ['ownsLifecycle'],
    },
    allowedCapabilities: ['source.read', 'local.test', 'source.analyze'],
    ...overrides,
  };
}

export function fixtureScope(run: RunManifest): Scope {
  return {
    authorizationRef: run.authorization.reference, targetIds: ['fixture'],
    actor: { id: 'local-reader', privileges: ['read-only'] },
    boundary: 'local fixture only', isolation: 'inert local lab', recovery: 'discard generated outputs',
    environmentId: 'lab-1', configurationDigest: CONFIG_HASH,
    inputs: [{ id: 'fixture', digest: HASH, locator: 'fixtures/input.ts', revision: 'r1' }],
  };
}

export function fixtureTask(run: RunManifest, taskId: string, workspace: string, overrides: Partial<TaskManifest> = {}): TaskManifest {
  return {
    schemaVersion: 1, runId: run.runId, taskId, dependencyTaskIds: [], depth: 0,
    createdAt: '2026-10-02T09:59:30.000Z', inputRevision: 'r1',
    question: {
      text: 'Does the local handler enforce its bounded input invariant?',
      ifTrue: 'Malformed local input is rejected before the handler',
      ifFalse: 'Malformed local input reaches the handler',
    },
    scope: fixtureScope(run), skills: ['static-review'], allowedActions: ['review'],
    requiredCapabilities: ['source.read'],
    budgets: {
      deadlineAt: TASK_DEADLINE, maxRequests: 5, maxBytes: 100_000, maxToolCalls: 20,
      maxTokens: 2_000, maxCostUsd: 2, maxAttempts: 3,
    },
    requestedRuntime: run.requestedRuntime, workspace, lifecycleState: 'queued', packetState: 'draft',
    ...overrides,
  };
}

export function collectorReceipt(options: {
  evidenceId: string; runId: string; taskId: string; attemptId: string; digest?: string;
  collectedAt: string; inputDigests?: string[]; purpose?: TestReceipt['purpose'];
}): EvidenceReceipt {
  const kind = options.purpose === undefined ? 'source' as const : options.purpose === 'baseline' ? 'baseline' as const : 'test' as const;
  return {
    schemaVersion: 1, evidenceId: options.evidenceId, runId: options.runId, taskId: options.taskId,
    attemptId: options.attemptId, kind,
    classification: kind === 'source' ? 'static-inference' : 'independently-observed',
    digest: options.digest ?? HASH, locator: `receipts/${options.evidenceId}.json`, mediaType: 'application/json',
    byteLength: 128, summary: 'Bounded local fixture receipt', redacted: true,
    provenance: {
      collectorId: 'collector-1', trust: 'collector', method: 'bounded local fixture collection',
      collectedAt: options.collectedAt, tool: { name: 'fixture-collector', version: '1.0.0', options: [] },
      environmentId: 'lab-1', configurationDigest: CONFIG_HASH, inputDigests: options.inputDigests ?? [HASH],
      originalEnvironment: true, modifications: [],
    },
    ...(options.purpose === undefined ? {} : {
      test: {
        purpose: options.purpose, outcome: 'passed' as const, successes: 1, attempts: 1,
        invariant: 'local input invariant', originalPolicy: true,
      },
    }),
  };
}

export function h2Packet(options: {
  runId: string; taskId: string; attemptId: string; producerId: string; scope: Scope; question: TaskManifest['question'];
  packetId?: string;
  inputRevision: string; requestedRuntime: RequestedRuntime; observedRuntime: ObservedRuntime;
  evidenceIds?: string[]; baselineEvidenceIds?: string[]; outcome?: HandoffPacket['outcome'];
  classification?: HandoffPacket['classification']; allowedActions?: string[]; createdAt?: string; untestedScope?: string[];
}): HandoffPacket {
  const details: H2Details = {
    minimalSlice: 'fixtures/input.ts#handler', invariant: 'Only accepted local input reaches the handler',
    controllableFields: ['input kind'], constraints: ['read-only local fixture'],
    unknown: 'receiver guard branch',
    predictions: {
      ifTrue: 'guard rejects malformed input', ifFalse: 'guard accepts malformed input',
      observableIfTrue: 'rejection receipt is collected', observableIfFalse: 'handler entry receipt is collected',
    },
    observationPoints: ['local handler return value'], instrumentation: [],
    prerequisites: ['original fixture build'], prerequisitesKnown: true,
    baseline: options.outcome === 'static-only'
      ? { status: 'unavailable', evidenceIds: [], reason: 'Static-only review has no runtime environment' }
      : { status: 'observed', evidenceIds: options.baselineEvidenceIds ?? ['baseline-1'] },
    lab: { safety: 'no target traffic; inert local fixture', isolation: 'inert local lab', authorized: true },
    modifiedBuild: false,
  };
  return {
    schemaVersion: 1, packetId: options.packetId ?? `packet-${options.attemptId}`, runId: options.runId, taskId: options.taskId,
    attemptId: options.attemptId, producer: { id: options.producerId, role: 'specialist' },
    consumer: { id: 'reviewer-1', role: 'verifier' }, createdAt: options.createdAt ?? NOW,
    inputRevision: options.inputRevision, scope: options.scope, question: options.question,
    classification: options.classification ?? 'independently-observed', outcome: options.outcome ?? 'supported',
    evidenceIds: options.evidenceIds ?? ['source-1', 'baseline-1'],
    limits: {
      negativeControlEvidenceIds: [], failedAssumptions: [],
      untestedScope: options.untestedScope ?? ['unexercised routes'], risks: ['bounded local fixture only'],
      reproduction: { successes: 1, attempts: 1 },
    },
    nextAction: { action: 'Review the local invariant and its bounded fixture', stopCondition: 'Stop after this fixture question', allowedActions: options.allowedActions ?? ['review'] },
    requestedRuntime: options.requestedRuntime, observedRuntime: options.observedRuntime,
    contract: 'H2', details,
  };
}

export interface Harness {
  root: string;
  controlRoot: string;
  workspaceRoot: string;
  store: DurableStore;
  clock: ManualClock;
  authority: FakeAuthority;
  runtime: FakeRuntime;
  runtimes: Record<string, import('../../src/runtime/types.js').RuntimeAdapter>;
  supervisor: Supervisor;
  run: RunManifest;
  perTargetConcurrency: number;
  task: (taskId: string, overrides?: Partial<TaskManifest>) => TaskManifest;
}

export function createHarness(options: {
  root?: string; store?: DurableStore; clock?: ManualClock; authority?: FakeAuthority;
  ownerId?: string; reviewerId?: string; automatic?: boolean; runOverrides?: Partial<RunManifest>;
  perTargetConcurrency?: number; runtimeOptions?: Partial<FakeRuntimeOptions>;
  results?: import('../../src/orchestrator/index.js').ResultCollector;
  events?: import('../../src/orchestrator/index.js').EventSink;
  ackWithoutSink?: boolean;
} = {}): Harness {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'p2o-orchestrator-'));
  const controlRoot = join(root, 'control');
  const workspaceRoot = join(root, 'workspaces');
  const clock = options.clock ?? new ManualClock();
  const authority = options.authority ?? new FakeAuthority();
  const store = options.store ?? openStore({ path: join(root, 'run.sqlite'), clock: () => clock.iso() });
  const run = fixtureRun(options.runOverrides);
  const runtimes: Harness['runtimes'] = {};
  const supervisor = createSupervisor({
    store, authority, controlRoot, workspaceRoot, runtimes,
    ownerId: options.ownerId ?? 'supervisor-a', reviewerId: options.reviewerId ?? 'reviewer-1',
    clock, automatic: options.automatic ?? false, pollMs: 25, leaseMs: 120_000,
    startupTimeoutMs: 2_000, operationTimeoutMs: 2_000, stopReserveMs: 500,
    ...(options.results ? { results: options.results } : {}),
    ...(options.events ? { events: options.events } : {}),
    ...(options.ackWithoutSink === undefined ? {} : { ackWithoutSink: options.ackWithoutSink }),
  });
  const runtime = new FakeRuntime({ now: () => clock.now(), ...options.runtimeOptions });
  runtime.hooks = supervisor.runtimeHooks();
  runtimes.headless = runtime;
  return {
    root, controlRoot, workspaceRoot, store, clock, authority, runtime, runtimes, supervisor, run,
    perTargetConcurrency: options.perTargetConcurrency ?? run.budgets.maxConcurrency,
    task: (taskId: string, overrides: Partial<TaskManifest> = {}) =>
      fixtureTask(run, taskId, supervisor.workspaceFor(taskId), overrides),
  };
}

export async function admitRunAndTasks(
  harness: Harness, tasks: TaskManifest[], options: { perTargetConcurrency?: number } = {},
): Promise<void> {
  await harness.supervisor.admitRun({
    manifest: harness.run, mode: 'managed',
    perTargetConcurrency: { fixture: options.perTargetConcurrency ?? harness.perTargetConcurrency },
  });
  for (const task of tasks) await harness.supervisor.admitTask({ manifest: task, role: 'worker' });
}

/** Same as admitRunAndTasks, with an explicit owner-approved role per task (e.g. worker + verifier). */
export async function admitRunAndRoleTasks(harness: Harness, entries: Array<{ task: TaskManifest; role: Role }>): Promise<void> {
  await harness.supervisor.admitRun({
    manifest: harness.run, mode: 'managed',
    perTargetConcurrency: { fixture: harness.perTargetConcurrency },
  });
  for (const entry of entries) await harness.supervisor.admitTask({ manifest: entry.task, role: entry.role });
}

export function supervisorOptionsFor(harness: Harness, overrides: Partial<SupervisorOptions> = {}): SupervisorOptions {
  return {
    store: harness.store, authority: harness.authority, controlRoot: harness.controlRoot,
    workspaceRoot: harness.workspaceRoot, runtimes: harness.runtimes, clock: harness.clock,
    ownerId: 'supervisor-b', reviewerId: 'reviewer-1', automatic: false, pollMs: 25, leaseMs: 120_000,
    startupTimeoutMs: 2_000, operationTimeoutMs: 2_000, stopReserveMs: 500, ...overrides,
  };
}

export const codeIs = (expected: string) => (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code === expected;
};

export function taskBudget(overrides: Partial<TaskManifest['budgets']> = {}): TaskManifest['budgets'] {
  return {
    deadlineAt: TASK_DEADLINE, maxRequests: 5, maxBytes: 100_000, maxToolCalls: 20,
    maxTokens: 2_000, maxCostUsd: 2, maxAttempts: 3, ...overrides,
  };
}

export function evidenceIdsFor(taskId: string): { source: string; baseline: string } {
  return { source: `source-${taskId}`, baseline: `baseline-${taskId}` };
}

/** Collector receipts for the task's first attempt: one source slice and one known-good baseline. */
export function admitTaskEvidence(harness: Harness, taskId: string): { source: string; baseline: string } {
  const attempt = harness.store.listAttempts(harness.run.runId, taskId)[0];
  if (!attempt) throw new Error(`no attempt recorded for ${taskId}`);
  const ids = evidenceIdsFor(taskId);
  harness.store.putEvidence(collectorReceipt({
    evidenceId: ids.source, runId: attempt.runId, taskId, attemptId: attempt.attemptId, collectedAt: harness.clock.iso(),
  }));
  harness.store.putEvidence(collectorReceipt({
    evidenceId: ids.baseline, runId: attempt.runId, taskId, attemptId: attempt.attemptId,
    collectedAt: harness.clock.iso(), purpose: 'baseline',
  }));
  return ids;
}

export function latestAttempt(harness: Harness, taskId: string): import('../../src/contracts/index.js').AttemptRecord {
  const attempt = harness.store.listAttempts(harness.run.runId, taskId).at(-1);
  if (!attempt) throw new Error(`no attempt recorded for ${taskId}`);
  return attempt;
}

/** Builds the packet a compliant worker would submit for the task's current attempt. */
export function packetFor(
  harness: Harness, taskId: string,
  overrides: Partial<Parameters<typeof h2Packet>[0]> = {},
): HandoffPacket {
  const task = harness.store.getTask(taskId);
  if (!task) throw new Error(`no task ${taskId}`);
  const attempt = latestAttempt(harness, taskId);
  const ids = evidenceIdsFor(taskId);
  return h2Packet({
    runId: task.runId, taskId, attemptId: attempt.attemptId, producerId: attempt.ownerId,
    scope: task.scope, question: task.question, inputRevision: task.inputRevision,
    requestedRuntime: attempt.requestedRuntime, observedRuntime: attempt.observedRuntime ?? {
      adapter: attempt.requestedRuntime.adapter, capabilities: { ownsLifecycle: true, canHardStop: true, canResume: true, streamsEvents: true, attestsRuntime: true },
      attestation: 'reported', observedAt: harness.clock.iso(), receiptEvidenceIds: [],
    },
    evidenceIds: [ids.source, ids.baseline], baselineEvidenceIds: [ids.baseline],
    createdAt: harness.clock.iso(), ...overrides,
  });
}

export async function submitPacket(
  harness: Harness, taskId: string, packet: HandoffPacket, key?: string,
): Promise<ResultAdmission> {
  const attempt = latestAttempt(harness, taskId);
  return harness.supervisor.submitResult(attempt.attemptId, {
    packet, idempotencyKey: key ?? `key-${attempt.attemptId}`,
  });
}

export async function submitAccepted(harness: Harness, taskId: string): Promise<ResultAdmission> {
  return submitPacket(harness, taskId, packetFor(harness, taskId));
}

export function eventTypes(harness: Harness): string[] {
  return harness.store.listEvents({ runId: harness.run.runId }).map(event => event.type);
}
