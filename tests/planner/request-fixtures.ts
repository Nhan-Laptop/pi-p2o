import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanIssue, RunManifest } from '../../src/contracts/index.js';
import {
  planRequestProposalDigest, type PlanRequestApproval, type PlanRequestApprovalDocument, type PlanRequestEnvelope,
  type PlanRequestProposal, type StoredPlanRequestProposal,
} from '../../src/contracts/plan-request.js';
import { createOwnerAuthority, createRequestApprovalAuthority, type RequestApprovalAuthority } from '../../src/application/authority.js';
import {
  createRequestPlanLedger, materializeRequestPlan, type MaterializedRequestPlan, type RequestPlanLedger,
} from '../../src/application/planner.js';
import type { OwnerGrant } from '../../src/application/types.js';

export const NOW = '2026-10-02T10:00:00.000Z';
export const APPROVAL_EXPIRY = '2026-10-02T11:45:00.000Z';
export const AUTHORIZATION_EXPIRY = '2026-10-02T12:00:00.000Z';
/** Policy scopes are evaluated against the wall clock; the broker fixture must not be expired at run time. */
export const POLICY_EXPIRY = '2099-10-02T12:00:00.000Z';
export const HASH = 'a'.repeat(64);
export const REQUEST_TASK = 'task-idor';
export const REQUEST_TARGET = 'lab-web';
export const ORIGINAL_PATH = '/api/v1/items/i-100?tenant=alpha';
/** The new path/query the generated proposal authors; no owner observation enumerated it. */
export const NEW_PATH = '/api/v1/items/i-200?tenant=beta';

export function requestRun(origin: string, overrides: Partial<RunManifest> = {}): RunManifest {
  const locator = origin.endsWith('/') ? origin : `${origin}/`;
  return {
    schemaVersion: 1, runId: 'run-request-1', createdAt: NOW, state: 'active',
    authorization: {
      reference: 'owner-approved-request-lab', authorizedBy: 'fixture-owner',
      validFrom: NOW, expiresAt: AUTHORIZATION_EXPIRY,
      targets: [
        { id: REQUEST_TARGET, kind: 'web', locator, digest: HASH, revision: 'r1' },
        { id: 'lab-source', kind: 'artifact', locator: 'fixtures/lab-server.ts', digest: HASH, revision: 'r1' },
      ],
      exclusions: [`${locator}api/v1/private`],
      allowedActions: ['read', 'analyze'],
    },
    budgets: {
      deadlineAt: '2026-10-02T11:30:00.000Z', maxRequests: 20, maxBytes: 1_000_000, maxToolCalls: 100,
      maxTokens: 10_000, maxCostUsd: 10, maxAttempts: 3, maxTasks: 8, maxDepth: 3, maxConcurrency: 3,
      reportReserveMs: 60_000, targetRequestLimits: { [REQUEST_TARGET]: 12, 'lab-source': 2 },
    },
    requestedRuntime: {
      adapter: 'headless', selection: { provider: 'fixture-provider', model: 'fixture-model', thinking: 'low' },
      requiredCapabilities: [],
    },
    allowedCapabilities: ['http.request', 'source.analyze'],
    ...overrides,
  };
}

export function requestEnvelope(origin: string, overrides: Partial<PlanRequestEnvelope> = {}): PlanRequestEnvelope {
  const locator = origin.endsWith('/') ? origin : `${origin}/`;
  return {
    targets: [
      { id: REQUEST_TARGET, kind: 'web', locator },
      { id: 'lab-source', kind: 'artifact', locator: 'fixtures/lab-server.ts' },
    ],
    taskGrants: [{
      taskId: REQUEST_TASK, targetIds: [REQUEST_TARGET], allowedActions: ['read'], allowedCapabilities: ['http.request'],
    }],
    accounts: ['anonymous', 'acct-guest'],
    accountGrants: [
      { accountId: 'anonymous', targetIds: [REQUEST_TARGET], actions: ['read'] },
      { accountId: 'acct-guest', targetIds: [REQUEST_TARGET], actions: ['read'] },
    ],
    allowedCapabilities: ['http.request'],
    allowedActions: ['read'],
    exclusions: [{ origin, pathPrefixes: ['/api/v1/private'] }],
    ...overrides,
  };
}

/** A concrete new path/query draft, exactly what a model author would write. */
export function requestDraft(origin: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'req-1', taskId: REQUEST_TASK, tool: 'http.request', method: 'GET',
    url: `${origin}${NEW_PATH}`, action: 'read', accountId: 'anonymous',
    expectation: { type: 'http', status: 200, bodyIncludes: 'beta-secret' },
    kind: 'test', classification: 'hypothesis',
    summary: 'Read the cross-tenant item as the same account the menu already used',
    purpose: 'A new item id and tenant query decide whether the read route authorizes on the client parameter',
    requests: 1,
    ...overrides,
  };
}

export function requestPacket(run: RunManifest, origin: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1, proposalId: 'reqplan-1', runId: run.runId,
    requests: [requestDraft(origin)],
    ...overrides,
  };
}

export function requestApprovalDocument(proposal: PlanRequestProposal, overrides: Partial<PlanRequestApprovalDocument> = {}): PlanRequestApprovalDocument {
  return {
    version: 1, approvalId: 'req-approval-1', proposalId: proposal.proposalId,
    proposalDigest: planRequestProposalDigest(proposal), runId: proposal.runId,
    approvedBy: 'fixture-owner', reference: 'owner-request-approval-1', approvedAt: NOW,
    expiresAt: APPROVAL_EXPIRY, requestCount: proposal.requests.length,
    ...overrides,
  };
}

export function requestTaskFor(): { question: { text: string }; surfaceId: string; actorId: string } {
  return {
    question: { text: 'Does the item read route authorize on the client-supplied tenant parameter?' },
    surfaceId: 'items-read', actorId: 'acct-guest',
  };
}

export function requestScope(run: RunManifest, origin: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1, runId: run.runId,
    authorization: { reference: run.authorization.reference, approvedBy: 'fixture-owner', notBefore: NOW, expiresAt: POLICY_EXPIRY },
    targets: [{
      id: REQUEST_TARGET, origins: [origin], pathPrefixes: ['/'], allowedCidrs: ['127.0.0.0/8'], excludedCidrs: [],
      methods: ['GET', 'HEAD', 'OPTIONS'], actions: ['read'], accounts: ['anonymous', 'acct-guest'],
      limits: { maxRequests: 20, maxBytes: 1_000_000, maxConcurrent: 2, rate: { requests: 100, windowMs: 1_000 } },
    }],
    exclusions: [{ origin, pathPrefixes: ['/api/v1/private'] }],
    accounts: [
      { id: 'anonymous', targetIds: [REQUEST_TARGET], actions: ['read'], expiresAt: POLICY_EXPIRY, kind: 'anonymous' },
      { id: 'acct-guest', targetIds: [REQUEST_TARGET], actions: ['read'], expiresAt: POLICY_EXPIRY, kind: 'credential' },
    ],
    grants: [{
      id: 'grant-request-1', taskId: REQUEST_TASK, attemptId: 'attempt-request-1', role: 'worker',
      capabilities: ['http.request'], targetIds: [REQUEST_TARGET], actions: ['read'], accountIds: ['anonymous', 'acct-guest'],
      expiresAt: POLICY_EXPIRY, maxCalls: 20, maxArtifactBytes: 1_000_000,
    }],
    ...overrides,
  };
}

export interface RequestHarness {
  root: string;
  controlRoot: string;
  origin: string;
  run: RunManifest;
  envelope: PlanRequestEnvelope;
  packet: Record<string, unknown>;
  stored: StoredPlanRequestProposal;
  digest: string;
  document: PlanRequestApprovalDocument;
  authority: RequestApprovalAuthority;
  ledger: RequestPlanLedger;
  proposeAgain(): ReturnType<RequestPlanLedger['propose']>;
  approve(): Promise<Awaited<ReturnType<RequestPlanLedger['approve']>>>;
  /** Owner-gate output, exactly what materialization consumes. */
  ownerApproval(): Promise<PlanRequestApproval>;
  materialize(): ReturnType<RequestPlanLedger['materialize']>;
  materializedPlan(approval: PlanRequestApproval): MaterializedRequestPlan;
}

/**
 * Two-phase fixture: the proposal is first stored by an authority that approves nothing, and only then is the
 * owner grant built around that exact digest. This is the production order and it makes self-approval impossible.
 */
export function createRequestHarness(options: {
  origin?: string; packet?: Record<string, unknown>; grantOwnerApproval?: boolean; caps?: { maxRequests?: number; maxProposals?: number };
} = {}): RequestHarness {
  const origin = options.origin ?? 'http://127.0.0.1:38999';
  const root = mkdtempSync(join(tmpdir(), 'p2o-request-plan-'));
  const controlRoot = join(root, 'control');
  const clock = () => Date.parse(NOW);
  const run = requestRun(origin);
  const envelope = requestEnvelope(origin);
  const packet = options.packet ?? requestPacket(run, origin);
  const bootstrap = createRequestPlanLedger({
    controlRoot, authority: createRequestApprovalAuthority({ approvals: [], now: clock }), clock,
    ...(options.caps ? { caps: options.caps } : {}),
  });
  const outcome = bootstrap.propose({
    packet, run, envelope, generatorAttemptId: 'gen-1', generatorKind: 'scripted',
    requestedSelection: run.requestedRuntime.selection, producedAt: NOW,
  });
  if (!outcome.ok) throw new Error(`fixture generated-request proposal was rejected: ${outcome.code} ${outcome.issues.map((issue: PlanIssue) => issue.message).join('; ')}`);
  const stored = outcome.record;
  const document = requestApprovalDocument(stored.proposal);
  const authority = createRequestApprovalAuthority({
    approvals: options.grantOwnerApproval === false ? [] : [document], now: clock,
  });
  const ledger = createRequestPlanLedger({
    controlRoot, authority, clock, ...(options.caps ? { caps: options.caps } : {}),
  });
  const materialize = () => ledger.materialize({
    run, proposalDigest: stored.digest, envelope, taskFor: requestTaskFor, now: NOW,
  });
  return {
    root, controlRoot, origin, run, envelope, packet, stored,
    digest: stored.digest, document, authority, ledger,
    proposeAgain: () => ledger.propose({
      packet, run, envelope, generatorAttemptId: 'gen-1', generatorKind: 'scripted',
      requestedSelection: run.requestedRuntime.selection, producedAt: NOW,
    }),
    approve: () => ledger.approve({ run, proposalDigest: stored.digest, document }),
    ownerApproval: () => authority.approveRequestProposal(stored.proposal, document, {
      runId: run.runId, now: NOW, authorizationRef: run.authorization.reference,
    }),
    materialize,
    materializedPlan: (approval: PlanRequestApproval) => materializeRequestPlan(stored.proposal, {
      run, approval, document, envelope, taskFor: requestTaskFor, now: NOW,
    }),
  };
}

/** Structurally augmented owner grant; `requestApprovals` is the only field outside the shared OwnerGrant type. */
export function ownerGrantWithRequestApprovals(run: RunManifest, documents: PlanRequestApprovalDocument[]): OwnerGrant & { requestApprovals: PlanRequestApprovalDocument[] } {
  return {
    version: 1,
    runs: [{ manifest: run, mode: 'managed', perTargetConcurrency: {} }],
    tasks: [],
    requestApprovals: documents,
  };
}

export function ownerAuthorityFor(run: RunManifest, documents: PlanRequestApprovalDocument[]) {
  return createOwnerAuthority(ownerGrantWithRequestApprovals(run, documents), { now: () => Date.parse(NOW) });
}

export interface LabServer {
  origin: string;
  hits: Array<{ url: string; method: string }>;
  close(): Promise<void>;
}

/** Loopback-only lab fixture: the original route plus the new cross-tenant route a proposal authors. */
export async function startLabServer(): Promise<LabServer> {
  const hits: Array<{ url: string; method: string }> = [];
  const server = createServer((request, response) => {
    const url = request.url ?? '/';
    hits.push({ url, method: request.method ?? 'GET' });
    response.setHeader('content-type', 'application/json');
    if (url.startsWith('/api/v1/items/i-200')) {
      response.end(JSON.stringify({ id: 'i-200', tenant: 'beta', value: 'beta-secret' }));
      return;
    }
    if (url.startsWith('/api/v1/items')) {
      response.end(JSON.stringify({ id: 'i-100', tenant: 'alpha', value: 'alpha-value' }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
