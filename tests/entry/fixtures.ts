/**
 * Shared fixtures for the entry-workflow tests.
 *
 * All fixtures are inert: no network, no workers, no model calls. The `stubBackend` is only a delegation
 * double; the real-backend test in `delegation.test.ts` builds the actual composed backend.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanProposal } from '../../src/contracts/plan.js';
import type { PlanRequestProposal } from '../../src/contracts/plan-request.js';
import type { RunManifest } from '../../src/contracts/types.js';
import type { ControlBackend, Preflight, Report, RunHandle, Snapshot, StartInput } from '../../src/interface/types.js';
import type { EntryHumanApproval } from '../../src/interface/target-entry.js';
import { humanConfirmationRef, issueHumanConfirmationCapability } from '../../src/interface/human-approval.js';
import { onboardingScopeFor, type OnboardingHandler, type OwnerConfiguration, type OwnerLimits } from '../../src/application/onboarding/index.js';
import type {
  EntryCommandRunner, EntryDelegationInput, EntryDelegationPort, EntryObserver,
  EntryPlanAuthor, EntryPlanAuthorOutput, EntryPlanExecution, EntryPlanExecutionCompletion, EntryRunBinding,
} from '../../src/application/entry/index.js';

export const NOW = Date.parse('2026-10-03T10:00:00.000Z');
export const iso = (ms: number): string => new Date(ms).toISOString();
export const digestOfObject = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function tempRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `p2o-entry-${label}-`));
}

export interface TestTargetOptions {
  localDir?: string;
  githubUrl?: string;
  webUrl?: string;
  webKind?: 'web' | 'service' | 'lab';
  runId?: string;
  mode?: 'fixture' | 'assessment';
  actions?: string[];
  allowedCapabilities?: string[];
  /** Extra owner-pinned digest/revision for the local artifact target. */
  localDigest?: string;
  localRevision?: string;
}

export function runManifestFor(options: TestTargetOptions): RunManifest {
  const runId = options.runId ?? 'run-entry-1';
  const targets: RunManifest['authorization']['targets'] = [];
  const limits: Record<string, number> = {};
  if (options.localDir) {
    targets.push({
      id: 'local-source', kind: 'artifact', locator: options.localDir,
      ...(options.localDigest ? { digest: options.localDigest } : {}),
      ...(options.localRevision ? { revision: options.localRevision } : {}),
    });
    limits['local-source'] = 0;
  }
  if (options.githubUrl) {
    targets.push({ id: 'repo-source', kind: 'artifact', locator: options.githubUrl });
    limits['repo-source'] = 0;
  }
  if (options.webUrl) {
    targets.push({ id: 'web-target', kind: options.webKind ?? 'lab', locator: options.webUrl });
    limits['web-target'] = 32;
  }
  return {
    schemaVersion: 1,
    runId,
    createdAt: iso(NOW - 60_000),
    state: 'active',
    authorization: {
      reference: 'owner-approved-entry-run',
      authorizedBy: 'entry-owner',
      validFrom: iso(NOW - 3_600_000),
      expiresAt: iso(NOW + 6 * 3_600_000),
      targets,
      exclusions: [],
      allowedActions: options.actions ?? ['analyze', 'read'],
    },
    budgets: {
      deadlineAt: iso(NOW + 3_600_000),
      maxRequests: 32,
      maxBytes: 4 * 1024 * 1024,
      maxToolCalls: 64,
      maxTokens: 100_000,
      maxCostUsd: 10,
      maxAttempts: 2,
      maxTasks: 4,
      maxDepth: 2,
      maxConcurrency: 2,
      reportReserveMs: 60_000,
      targetRequestLimits: limits,
    },
    requestedRuntime: {
      adapter: 'inert-fixture',
      selection: { provider: 'inert', model: 'inert-worker', thinking: 'low' },
      requiredCapabilities: [],
    },
    allowedCapabilities: options.allowedCapabilities ?? ['source.analyze', 'http.request'],
  };
}

export function stubBackend(overrides: Partial<ControlBackend> = {}): ControlBackend {
  const requested = { provider: 'inert', model: 'inert-worker', thinking: 'low' as const };
  return {
    async preflight(request: StartInput): Promise<Preflight> {
      return { ok: true, mode: request.mode, runId: 'run-entry-1', requested: { adapter: 'inert-fixture', selection: requested }, issues: [], warnings: [] };
    },
    async start(request: StartInput): Promise<RunHandle> { return { runId: 'run-entry-1', mode: request.mode }; },
    async resume(request): Promise<RunHandle> { return { runId: request.runId, mode: request.mode }; },
    async stop(runId: string) { return { runId, schedulingStopped: true, terminationVerified: true, failures: [] }; },
    async status(): Promise<Snapshot> {
      return { mode: 'fixture', run: { runId: 'run-entry-1', state: 'active' }, tasks: [], attempts: [], packets: [], findings: [], coverage: [], failures: [] };
    },
    async tasks(_runId, page) { return { items: [], total: 0, offset: page.offset }; },
    async evidence(_runId, page) { return { items: [], total: 0, offset: page.offset }; },
    async report(_runId, format): Promise<Report> { return { format, content: { runId: 'run-entry-1' } }; },
    async events(_runId, page) { return { items: [], nextSequence: page.afterSequence, gap: false }; },
    async close(): Promise<void> {},
    ...overrides,
  };
}

export function bindingFor(options: {
  backend?: ControlBackend;
  manifestPath: string;
  run: RunManifest;
  mode?: 'fixture' | 'assessment';
  requestEnvelope?: EntryRunBinding['requestEnvelope'];
  ownerObservations?: EntryRunBinding['ownerObservations'];
}): EntryRunBinding {
  const mode = options.mode ?? 'fixture';
  return {
    backend: options.backend ?? stubBackend(),
    manifestPath: options.manifestPath,
    mode,
    run: options.run,
    approvedTargets: options.run.authorization.targets.map(target => ({
      targetId: target.id,
      kind: target.kind,
      locator: target.locator,
      ...(target.digest ? { digest: target.digest } : {}),
      ...(target.revision ? { revision: target.revision } : {}),
      actions: [...options.run.authorization.allowedActions],
      accounts: [],
    })),
    ownerObservations: options.ownerObservations ?? [],
    ...(options.requestEnvelope ? { requestEnvelope: options.requestEnvelope } : {}),
  };
}

/**
 * TEST-ONLY preconfigured-owner double for the `P2O_APP_CONFIG` contract suites.
 *
 * Those suites exercise the preconfigured assessment document (target list, budgets, approvals), not the
 * first-use dialog flow; tests/onboarding and tests/command/onboarding.contract.test.ts own onboarding
 * itself. The handler returns the saved consent an out-of-band human approval would have produced: scope is
 * the exact requested target and limits mirror the preconfigured run document, never more. It mints no plan
 * approval, opens no UI, and does not replace the command's own owner gate: `assertOwnerPreparation` still
 * checks the prepared actions/spend and the entry port still refuses out-of-document targets (`TARGET_DENIED`).
 * Production always uses the real `ensureOwnerOnboarding` human-UI handler.
 */
export function preconfiguredOwnerConsent(documentPath: string): OnboardingHandler {
  const run = (JSON.parse(readFileSync(documentPath, 'utf8')) as { run: RunManifest }).run;
  const limits: OwnerLimits = {
    maxCostUsd: run.budgets.maxCostUsd,
    maxRequests: run.budgets.maxRequests,
    maxTokens: run.budgets.maxTokens,
    maxToolCalls: run.budgets.maxToolCalls,
    maxAttempts: run.budgets.maxAttempts,
    deadlineMs: Date.parse(run.budgets.deadlineAt),
    concurrency: run.budgets.maxConcurrency,
  };
  // Read/static only: the preconfigured suites never grant repository scripts or state changes.
  const permissions = { readStatic: true as const, repositoryScripts: false, stateChanges: false };
  return async input => {
    const configuration: OwnerConfiguration = {
      schemaVersion: 1,
      owner: { uid: process.getuid!() },
      scope: onboardingScopeFor(input.target, input.cwd),
      authorization: { basis: 'owner', reference: 'preconfigured owner document (host-approved test scenario)', attestation: 'human-self-attested' },
      permissions,
      allowedActions: ['read', 'analyze'],
      limits,
      disclosure: { version: 1, modelCosts: true, modelDataSharing: true, planOnlyTargetIO: 0 },
    };
    return {
      status: 'ready', configuration, effectiveLimits: limits, effectivePermissions: permissions,
      configPath: documentPath, receiptPath: documentPath, reused: true,
    };
  };
}

/**
 * Human-command approval fixture: mints the same non-serializable, single-use capability the command
 * handler issues, bound to the run/scope/plan the port will verify. Tests never fabricate the capability
 * by hand, and the port refuses a hand-written `channel: 'human-command'` value without one.
 */
export function approvalFor(scopeDigest: string, planDigest: string, _ref = 'human-test', runId = 'run-entry-1'): EntryHumanApproval {
  const capability = issueHumanConfirmationCapability({ runId, scopeDigest, planDigest });
  const { approvalRef, approvedAt } = humanConfirmationRef(capability);
  return { channel: 'human-command', approvalRef, approvedAt, scopeDigest, planDigest, authority: capability };
}

export function generatedPacket(input: {
  runId: string;
  taskId?: string;
  requestId?: string;
  url: string;
  accountId?: string;
  proposalId?: string;
  expectationStatus?: number;
}): PlanRequestProposal {
  return {
    schemaVersion: 1,
    proposalId: input.proposalId ?? 'req-proposal-1',
    runId: input.runId,
    generator: {
      generatorAttemptId: 'attempt-planner-1',
      generatorKind: 'worker',
      requestedSelection: { provider: 'inert', model: 'inert-worker', thinking: 'low' },
      inputDigests: [],
      producedAt: iso(NOW),
    },
    requests: [{
      requestId: input.requestId ?? 'req-1',
      taskId: input.taskId ?? 'task-recon',
      tool: 'http.request',
      method: 'GET',
      url: input.url,
      action: 'read',
      accountId: input.accountId ?? 'guest',
      kind: 'observation',
      classification: 'static-inference',
      summary: 'bounded owner-scope recon',
      purpose: 'decide whether the reachable route exposes the claimed surface',
      requests: 1,
      expectation: { type: 'http', status: input.expectationStatus ?? 200 },
    }],
  };
}

export function fixtureAuthor(output: EntryPlanAuthorOutput): EntryPlanAuthor {
  return { async author() { return output; } };
}

export function generatedAuthor(url: string, runId: string): EntryPlanAuthor {
  return fixtureAuthor({
    authoredBy: 'fixture',
    attemptId: 'attempt-model-1',
    steps: ['open the owner-approved origin', 'request the bounded route'],
    packet: { kind: 'generated-requests', proposal: generatedPacket({ runId, url }) },
  });
}

/** Recording execution double with inspectable propose/complete calls. */
export interface RecordingExecution extends EntryPlanExecution {
  proposed: Array<{ kind: string; proposalId: string }>;
  /** Plan digests the port owner-gated *before* acquisition. */
  authorized: string[];
  completed: Array<{ planId: string; approvalRef: string }>;
  availability: { ok: boolean; code?: string; message?: string };
}

export function recordingExecution(kind: 'owner-menu' | 'generated-requests', options: { available?: boolean; code?: string; message?: string } = {}): RecordingExecution {
  const proposed: Array<{ kind: string; proposalId: string }> = [];
  const authorized: string[] = [];
  const completed: Array<{ planId: string; approvalRef: string }> = [];
  return {
    kind,
    proposed,
    authorized,
    completed,
    availability: options.available === false
      ? { ok: false, code: options.code ?? 'ENTRY_GENERATED_REQUESTS_UNSUPPORTED', message: options.message ?? 'execution is not wired' }
      : { ok: true },
    async available() {
      return this.availability.ok
        ? { ok: true as const }
        : { ok: false as const, code: this.availability.code ?? 'ENTRY_FAILED', message: this.availability.message ?? 'unavailable' };
    },
    async propose() {
      proposed.push({ kind, proposalId: `${kind}-proposal-1` });
      return { proposalId: `${kind}-proposal-1`, proposalDigest: digestOfObject({ kind, index: proposed.length }) };
    },
    async authorize(input) {
      authorized.push(input.proposalDigest);
    },
    async complete(input): Promise<EntryPlanExecutionCompletion> {
      completed.push({ planId: input.plan.planId, approvalRef: input.approval.approvalRef });
      return { proposalId: `${kind}-proposal-1`, proposalDigest: 'c'.repeat(64), taskIds: ['task-recon'], observationIds: ['obs-1'] };
    },
  };
}

export interface RecordingDelegation {
  calls: string[];
  inputs: EntryDelegationInput[];
  port: EntryDelegationPort;
}

export function recordingDelegation(options: { runId?: string; state?: string; preflightOk?: boolean; preflightCode?: string } = {}): RecordingDelegation {
  const calls: string[] = [];
  const inputs: EntryDelegationInput[] = [];
  const runId = options.runId ?? 'run-entry-1';
  const state = options.state ?? 'active';
  return {
    calls,
    inputs,
    port: {
      async preflight() {
        calls.push('preflight');
        return options.preflightOk === false
          ? { ok: false, runId, issues: [{ code: options.preflightCode ?? 'SCOPE_EXPIRED', message: 'owner authorization is not current' }], warnings: [] }
          : { ok: true, runId, issues: [], warnings: [] };
      },
      async delegate(input) {
        calls.push('delegate');
        inputs.push(input);
        return { runId, state };
      },
      async resume() {
        calls.push('resume');
        return { runId, state };
      },
    },
  };
}

export function recordingObserver(): { observer: EntryObserver; events: string[] } {
  const events: string[] = [];
  return {
    events,
    observer: {
      io(event) { events.push(`io:${event.kind}`); },
      decision(event) { events.push(`decision:${event.step}`); },
    },
  };
}

/** Recording git runner; creates a synthetic clone and answers `rev-parse`. Never contacts the network. */
export function fakeGitRunner(options: { revision?: string; cloneExit?: number; stderr?: string } = {}): { runner: EntryCommandRunner; invocations: Array<{ args: string[]; env: Record<string, string>; file: string }> } {
  const invocations: Array<{ args: string[]; env: Record<string, string>; file: string }> = [];
  const revision = options.revision ?? 'a'.repeat(40);
  const runner: EntryCommandRunner = {
    async run(input) {
      invocations.push({ args: [...input.args], env: { ...input.env }, file: input.file });
      if (input.args[0] === 'clone') {
        if (options.cloneExit !== undefined && options.cloneExit !== 0) return { code: options.cloneExit, stdout: '', stderr: options.stderr ?? '' };
        const destination = input.args[input.args.length - 1]!;
        mkdirSync(join(destination, '.git'), { recursive: true });
        mkdirSync(join(destination, 'src'), { recursive: true });
        writeFileSync(join(destination, 'src', 'index.ts'), 'export const fixture = true;\n');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (input.args.includes('rev-parse')) return { code: 0, stdout: `${revision}\n`, stderr: '' };
      return { code: 1, stdout: '', stderr: 'unexpected git invocation' };
    },
  };
  return { runner, invocations };
}


/** Owner-menu proposal selecting exactly one owner-approved observation on one approved target. */
export function ownerMenuProposal(input: {
  run: RunManifest;
  targetId: string;
  targetKind: 'artifact' | 'web' | 'service' | 'lab';
  targetLocator: string;
  observationId: string;
  taskId?: string;
  proposalId?: string;
}): PlanProposal {
  const taskId = input.taskId ?? 'task-review';
  const actor = { id: 'entry-auditor', privileges: ['read'] };
  const question = {
    text: 'Does the approved snapshot expose an unguarded entry point?',
    ifTrue: 'The observed path is unguarded and a bounded follow-up is justified.',
    ifFalse: 'The observed path enforces its guard.',
  };
  return {
    schemaVersion: 1,
    proposalId: input.proposalId ?? 'plan-proposal-1',
    run: {
      runId: input.run.runId,
      purpose: 'read-only static review of the owner-approved snapshot',
      inputRevision: 'entry-revision-1',
      scope: {
        authorizationRef: input.run.authorization.reference,
        targetIds: [input.targetId],
        actor,
        boundary: 'owner-approved read-only snapshot',
        isolation: 'private per-run workspace',
        recovery: 'discard the private view',
        environmentId: 'entry-env-1',
        configurationDigest: 'a'.repeat(64),
        inputs: [],
      },
      targets: [{ id: input.targetId, kind: input.targetKind, locator: input.targetLocator }],
      accounts: [],
      allowedCapabilities: ['source.analyze'],
      allowedActions: ['analyze'],
      budgets: {
        deadlineAt: iso(NOW + 1_800_000),
        maxRequests: 8,
        maxBytes: 1_000_000,
        maxToolCalls: 8,
        maxTokens: 10_000,
        maxCostUsd: 1,
        maxAttempts: 1,
        maxTasks: 2,
        maxDepth: 1,
        maxConcurrency: 1,
      },
    },
    tasks: [{
      taskId,
      question,
      surfaceId: 'surface-snapshot',
      surface: 'snapshot:src/app.ts',
      actor,
      targetIds: [input.targetId],
      skills: ['source-code-auditing'],
      allowedActions: ['analyze'],
      requiredCapabilities: ['source.analyze'],
      dependencies: [],
      priority: 'normal',
      depth: 0,
    }],
    observations: [{
      observationId: input.observationId,
      taskId,
      tool: 'source.analyze',
      input: { path: 'src/app.ts' },
      kind: 'source',
      classification: 'static-inference',
      summary: 'review the approved snapshot entry point',
      requests: 1,
    }],
    coverage: [{
      cellId: 'cell-1',
      taskId,
      surfaceId: 'surface-snapshot',
      actorId: actor.id,
      question: question.text,
    }],
    caps: { maxTasks: 2, maxDepth: 1, maxObservations: 4, maxRequests: 8 },
    provenance: {
      plannerAttemptId: 'attempt-model-1',
      plannerKind: 'worker',
      requestedSelection: { provider: 'inert', model: 'inert-worker', thinking: 'low' },
      inputDigests: [],
      producedAt: iso(NOW),
    },
  };
}
