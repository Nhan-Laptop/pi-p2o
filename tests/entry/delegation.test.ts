/**
 * Real-backend delegation test.
 *
 * Builds the actual composed backend — real `DurableStore`, real `createSupervisor`, the real
 * `createSupervisorBackend`, an inert runtime adapter that owns no process — against an inert loopback HTTP
 * fixture, then drives the entry port end to end: prepare → model-authored plan → human approval → real
 * `createRequestPlanLedger` proposal → real owner-gate approval → real `materializeRequestPlan` → registration
 * → delegation to the composed backend.
 *
 * The entry workflow itself must issue zero requests to the fixture; only owner-approved observations under
 * the broker may ever do that, and no worker runs here (the run admits zero tasks).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digestJson } from '../../src/contracts/index.js';
import { createRequestApprovalAuthority, type RequestApprovalAuthority } from '../../src/application/authority.js';
import { createApplicationEntryPort } from '../../src/application/entry/index.js';
import { createRequestPlanLedger, type MaterializedRequestPlan } from '../../src/application/planner.js';
import { createOrchestratorPort } from '../../src/interface/orchestrator-port.js';
import { createSupervisorBackend } from '../../src/interface/supervisor-backend.js';
import { createSupervisor, type Authority } from '../../src/orchestrator/index.js';
import { openStore } from '../../src/store/index.js';
import type { RuntimeAdapter, RuntimeCheckpoint, RuntimeCollection, RuntimeHandle, RuntimeObservation, RuntimeRequest, ReconciliationReceipt, PreflightReceipt, StopReceipt } from '../../src/runtime/types.js';
import { approvalFor, generatedPacket, iso, NOW, runManifestFor, tempRoot } from './fixtures.js';

const HASH = 'a'.repeat(64);

/** Test-only owner authority for the *run* admission; approves exactly the canonical proposal it is handed. */
function inertRunAuthority() {
  const admissions: Array<{ mode: string; runId: string }> = [];
  return {
    admissions,
    async verifyRun(proposal: never) {
      const admission = proposal as unknown as { mode: string; manifest: { runId: string; authorization: { reference: string; authorizedBy: string; expiresAt: string } } };
      admissions.push({ mode: admission.mode, runId: admission.manifest.runId });
      return {
        allowed: true,
        digest: digestJson(proposal),
        authorizationRef: admission.manifest.authorization.reference,
        approvedBy: admission.manifest.authorization.authorizedBy,
        reference: `inert-entry-approval-${admission.manifest.authorization.reference}`,
        expiresAt: admission.manifest.authorization.expiresAt,
      };
    },
    async approveTask() { throw new Error('this fixture admits no owner-approved tasks'); },
    async approveReplacement() { throw new Error('this fixture replaces no attempts'); },
  };
}

/** Inert runtime adapter: explicit capability accounting, no process, no isolation claim. */
function inertRuntime(): RuntimeAdapter {
  const capability = { ownsLifecycle: true, canHardStop: true, canResume: false, streamsEvents: true, attestsRuntime: false, checkpoints: false, sandboxBoundTools: false };
  const handle = (request: RuntimeRequest): RuntimeHandle => ({
    version: 1, kind: 'headless', runId: request.runId, taskId: request.taskId, attemptId: request.attemptId,
    ownerToken: 'inert-owner-token', workspace: request.workspace, scopeDigest: request.scopeDigest, inputDigest: request.inputDigest,
    deadlineAt: request.deadlineAt, requested: request.requested, toolPolicy: request.toolPolicy, createdAt: NOW, status: 'ready',
    controlDir: request.workspace, sessionFile: '', sessionId: 'inert-session', launchIntent: false,
    native: { processes: [] }, observed: [], events: [], nextCursor: 0, logTail: '', droppedLogBytes: 0,
  });
  return {
    kind: 'headless', capabilities: capability,
    async preflight(): Promise<PreflightReceipt> { return { ok: true, kind: 'headless', checkedAt: NOW, capabilities: capability, errors: [], warnings: ['inert entry fixture: no process, no isolation claim'] }; },
    async start(request: RuntimeRequest): Promise<RuntimeHandle> { return handle(request); },
    async observe(current: RuntimeHandle): Promise<RuntimeObservation> { return { status: 'ready', events: [], cursor: current.nextCursor, gap: false, requested: current.requested, observed: [] }; },
    async checkpoint(current: RuntimeHandle, options?: { note?: string }): Promise<RuntimeCheckpoint> {
      void options;
      return { version: 1, id: 'inert-checkpoint-1', createdAt: NOW, handle: current, session: { path: '', sha256: HASH, id: 'inert-session', bytes: 0 }, termination: { reason: 'checkpoint', at: NOW, verified: false, survivors: [] }, restoredToolProcesses: false };
    },
    async stop(): Promise<StopReceipt> { return { reason: 'cancelled', at: NOW, verified: true, survivors: [] }; },
    async resume(_checkpoint: RuntimeCheckpoint, request: RuntimeRequest): Promise<RuntimeHandle> { return handle(request); },
    async collect(current: RuntimeHandle): Promise<RuntimeCollection> { return { handle: current, outcome: 'ready', logTail: '', droppedLogBytes: 0, requested: current.requested, observed: [], resultAcceptance: 'not-evaluated' }; },
    async reconcile(current: RuntimeHandle): Promise<ReconciliationReceipt> { return { state: 'live', handle: current, explanation: 'inert adapter holds no process' }; },
  };
}

let server: Server | undefined;
let requests: string[] = [];
let origin = '';

beforeAll(async () => {
  requests = [];
  server = createServer((request, response) => {
    requests.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('inert fixture\n');
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
});

describe('real composed backend delegation', () => {
  it('admits and launches through the existing supervisor after the owner gate materializes the plan', async () => {
    const root = realpathSync(tempRoot('delegation-real'));

    const workspaceRoot = join(root, 'workspace');
    const controlRoot = join(root, 'controller');
    mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
    mkdirSync(controlRoot, { recursive: true, mode: 0o700 });

    const run = runManifestFor({ webUrl: `${origin}/`, runId: 'run-entry-real' });
    run.requestedRuntime.requiredCapabilities = ['ownsLifecycle'];
    const manifestPath = join(root, 'run-manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(run)}\n`, { mode: 0o600 });

    const store = openStore({ path: join(root, 'store.sqlite'), clock: () => iso(NOW) });
    const authority = inertRunAuthority();
    const adapter = inertRuntime();
    const supervisor = createSupervisor({
      controlRoot,
      workspaceRoot,
      store,
      authority: authority as unknown as Authority,
      runtimes: { 'inert-fixture': adapter },
      clock: { now: () => NOW, setTimeout: () => 0, clearTimeout: () => undefined },
      automatic: false,
    });
    const backend = createSupervisorBackend({
      store,
      supervisor: createOrchestratorPort(supervisor, { runtimes: { 'inert-fixture': adapter } }),
      now: () => NOW,
      render: (runId: string, format: 'json' | 'markdown') => ({ runId, format, acceptedOnly: true }),
    });

    // Real generated-request ledger. The owner gate is created only after the proposal is sealed (the owner
    // writes their approval against the observed digest); the proxy never mints or edits an approval.
    let ownerGate: RequestApprovalAuthority | undefined;
    const gateProxy: RequestApprovalAuthority = {
      approveRequestProposal(proposal, document, context) {
        if (!ownerGate) throw new Error('permission-denied: the owner has not authored an approval document yet');
        return ownerGate.approveRequestProposal(proposal, document, context);
      },
    };
    const ledger = createRequestPlanLedger({ controlRoot: join(root, 'request-control'), authority: gateProxy, clock: () => NOW });

    const ownerDocumentPath = join(root, 'owner-request-approval.json');
    const registered: MaterializedRequestPlan[] = [];
    const runUrl = `${origin}/health`;
    const requestEnvelope = {
      targets: [{ id: 'web-target', kind: 'lab' as const, locator: `${origin}/` }],
      taskGrants: [{ taskId: 'task-recon', targetIds: ['web-target'], allowedActions: ['read'], allowedCapabilities: ['http.request'] }],
      accounts: ['guest'],
      allowedCapabilities: ['http.request'],
      allowedActions: ['read'],
      exclusions: [],
    };
    const port = await createApplicationEntryPort({
      backend,
      manifestPath,
      mode: 'fixture',
      workspaceRoot,
      cwd: root,
      requestEnvelope,
      planAuthor: {
        async author() {
          return {
            authoredBy: 'model',
            attemptId: 'attempt-model-1',
            steps: ['resolve the owner-approved origin', 'issue the bounded observation through the broker'],
            packet: { kind: 'generated-requests', proposal: generatedPacket({ runId: run.runId, url: runUrl }) },
          };
        },
      },
      generated: {
        ledger,
        ownerDocumentPath,
        register: async ({ materialized }) => {
          registered.push(materialized);
          return { taskIds: materialized.taskIds, observationIds: materialized.checks.map(check => check.observationId) };
        },
      },
      clock: () => NOW,
      newId: () => 'entry-real',
    });

    try {
      const preparation = await port.prepare!({ target: { kind: 'http-url', raw: `${origin}/`, locator: `${origin}/` }, depth: 'standard', planOnly: false });
      expect(preparation.runId).toBe(run.runId);
      expect(preparation.targetRequests).toBe(0);

      const plan = await port.plan!({ preparation });
      const stored = ledger.read(run.runId).proposals[0];
      expect(stored).toBeDefined();

      // The owner authors the approval against the exact sealed digest, then the gate can verify it.
      const document = {
        version: 1 as const,
        approvalId: 'entry-approval-1',
        proposalId: stored!.proposalId,
        proposalDigest: stored!.digest,
        runId: run.runId,
        approvedBy: 'entry-owner',
        reference: run.authorization.reference,
        approvedAt: iso(NOW - 1_000),
        expiresAt: iso(NOW + 3_600_000),
        requestCount: 1,
      };
      writeFileSync(ownerDocumentPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
      ownerGate = createRequestApprovalAuthority({ approvals: [document], now: () => NOW });

      const result = await port.start!({ preparation, plan, approval: approvalFor(preparation.scopeDigest, plan.digest, 'human-test', run.runId) });

      // The real ledger recorded the owner approval and the real materializer produced the checks + grants.
      expect(ledger.read(run.runId).approvals).toHaveLength(1);
      expect(registered).toHaveLength(1);
      expect(registered[0]!.checks).toHaveLength(1);
      expect(registered[0]!.grants).toHaveLength(1);
      expect(registered[0]!.grants[0]).toMatchObject({ tool: 'http.request', method: 'GET', url: runUrl, action: 'read', targetId: 'web-target', accountId: 'guest' });
      expect(registered[0]!.grants[0]!.expiresAt).toBe(document.expiresAt);

      // The existing supervisor admitted and launched the owner-approved run; the state is the observed one.
      const durable = store.getRun(run.runId);
      expect(durable).toBeDefined();
      expect(result.runId).toBe(run.runId);
      // Launch is not acceptance: the entry port reports the state the composed backend observed, and the
      // durable run state is read from the same real store (a zero-task run settles independently).
      expect(['active', 'completed']).toContain(result.state);
      expect(['active', 'completed']).toContain(durable!.state);
      expect(authority.admissions).toHaveLength(1);
      expect(authority.admissions[0]).toMatchObject({ mode: 'managed', runId: run.runId });
      expect(store.listEvents({ runId: run.runId }).some(event => event.type === 'orchestrator.run-admitted')).toBe(true);

      // The entry workflow itself never contacted the fixture; only approved observations could.
      expect(requests).toEqual([]);
    } finally {
      await backend.close();
      store.close();
    }
  });
});
