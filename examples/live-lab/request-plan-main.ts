#!/usr/bin/env node
// Generated-request demo harness (local fixtures only).
//
// What this demonstrates, end to end, with a real ledger + real broker against a loopback fixture:
//
//   author   a scripted model-author stand-in writes a concrete http.request for a NEW path and query that
//            the owner observation menu never enumerated (an IDOR-style cross-tenant read);
//   propose  the validator constrains it to the owner target/account/action/budget envelope, and the ledger
//            stores it under its canonical digest. Nothing was dispatched;
//   gate     materialization before owner approval is REFUSED (`request-plan-unapproved`) and the fixture
//            records zero hits for the new path;
//   owner    an explicitly labeled lab-owner document approves that exact digest. This is a lab scripted
//            approval, NOT an independent human owner, and it only ever covers this loopback fixture;
//   execute  the materialized check/grant runs through the real ToolBroker (local-fixture sandbox, DNS pin,
//            policy, budget), and the fixture sees exactly one request to the new path;
//   negative mutated URL/account change the digest and the old approval refuses to bind; an off-scope origin
//            and an owner-excluded path are refused at proposal time; nothing is contacted;
//   replay   a fresh ledger over the same control root converges: one proposal, one approval, identical
//            check/grant identities.
//
// NO live model call is made (0 calls, $0.00 spent): the scripted author exists precisely so this demo is
// reproducible without provider credentials. A live run would need one small proposal call and a real owner.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestApprovalAuthority } from '../../src/application/authority.js';
import { createRequestPlanLedger, materializeRequestPlan, type RequestPlanLedger } from '../../src/application/planner.js';
import { digestJson, type RunManifest } from '../../src/contracts/index.js';
import {
  planRequestProposalDigest, validatePlanRequestProposal,
  type PlanRequestApprovalDocument, type PlanRequestEnvelope, type PlanRequestProposal,
} from '../../src/contracts/plan-request.js';
import { createPolicy, TargetBudget, type Scope } from '../../src/policy/index.js';
import { createLocalFixtureSandbox, createToolBroker, type HttpEvidence } from '../../src/tools/index.js';

const NOW = '2026-10-02T10:00:00.000Z';
const APPROVAL_EXPIRY = '2026-10-02T11:45:00.000Z';
const POLICY_EXPIRY = '2099-10-02T12:00:00.000Z';
const HASH = 'a'.repeat(64);
const TASK = 'task-idor';
const TARGET = 'lab-web';
const ORIGINAL_URL_PATH = '/api/v1/items/i-100?tenant=alpha';
const NEW_URL_PATH = '/api/v1/items/i-200?tenant=beta';
const EXCLUDED_PATH = '/api/v1/private/i-200?tenant=beta';
const SCRIPTED_AUTHOR = 'SCRIPTED-MODEL-AUTHOR (lab-only deterministic stand-in; not a live model)';
const SCRIPTED_OWNER = 'SCRIPTED-LAB-OWNER (lab-only scripted approval; not an independent approver)';

export interface RequestPlanDemoResult {
  origin: string;
  proposalId: string;
  digest: string;
  newUrl: string;
  refusals: Array<{ step: string; code: string }>;
  execution: { status: number; bodyHasSecret: boolean; pinnedAddress: string };
  replay: { proposals: number; approvals: number; duplicateApproval: boolean; identicalIdentities: boolean };
  acceptance: { ok: boolean; reasons: string[] };
}

export function formatRequestPlanDemo(result: RequestPlanDemoResult): string {
  return [
    `lab target (loopback fixture, owner-approved origin): ${result.origin}`,
    `owner menu enumerated only: ${ORIGINAL_URL_PATH}`,
    `scripted author: ${SCRIPTED_AUTHOR}`,
    `  NEW request: GET ${result.newUrl} account=anonymous (query and path were never in the menu)`,
    `  proposal=${result.proposalId} digest=${result.digest}`,
    `scripted owner gate: ${SCRIPTED_OWNER}`,
    'refusals (each with the fixture untouched):',
    ...result.refusals.map(refusal => `  ${refusal.step}: REFUSED ${refusal.code}`),
    `broker execution: status=${result.execution.status} beta-secret=${result.execution.bodyHasSecret} pinned=${result.execution.pinnedAddress}`,
    `restart/replay: proposals=${result.replay.proposals} approvals=${result.replay.approvals} duplicateApproval=${result.replay.duplicateApproval} identicalIdentities=${result.replay.identicalIdentities}`,
    `no live model call was made (0 calls, $0.00 spent); the scripted approval covers only this loopback fixture`,
    `ACCEPTANCE ok=${result.acceptance.ok}${result.acceptance.ok ? '' : ` reasons=${result.acceptance.reasons.join(' | ')}`}`,
  ].join('\n');
}

export async function runRequestPlanDemo(options: { log: (line: string) => void }): Promise<RequestPlanDemoResult> {
  const log = options.log;
  const reasons = new Set<string>();
  const check = (condition: boolean, message: string): boolean => {
    if (!condition) reasons.add(message);
    return condition;
  };
  const hits: string[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? '/';
    hits.push(url);
    response.setHeader('content-type', 'application/json');
    if (url.startsWith('/api/v1/items/i-200')) response.end(JSON.stringify({ id: 'i-200', tenant: 'beta', value: 'beta-secret' }));
    else if (url.startsWith('/api/v1/items')) response.end(JSON.stringify({ id: 'i-100', tenant: 'alpha', value: 'alpha-value' }));
    else { response.statusCode = 404; response.end(JSON.stringify({ error: 'not_found' })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const locator = `${origin}/`;
  const root = mkdtempSync(join(tmpdir(), 'p2o-request-plan-demo-'));
  const controlRoot = join(root, 'control');
  // Mutated/off-scope attempts get their own control root so the demo run keeps exactly one proposal.
  const mutationRoot = join(root, 'mutations');
  const inputRoot = join(root, 'inputs');
  const outputRoot = join(root, 'outputs');
  for (const directory of [controlRoot, mutationRoot, inputRoot, outputRoot]) mkdirSync(directory, { recursive: true, mode: 0o700 });

  const run: RunManifest = {
    schemaVersion: 1, runId: 'demo-request-run', createdAt: NOW, state: 'active',
    authorization: {
      reference: 'demo-owner-request-approval', authorizedBy: 'demo-owner',
      validFrom: NOW, expiresAt: '2099-10-02T12:00:00.000Z',
      targets: [
        { id: TARGET, kind: 'web', locator, digest: HASH, revision: 'r1' },
        { id: 'lab-source', kind: 'artifact', locator: 'lab-server.mjs', digest: HASH, revision: 'r1' },
      ],
      exclusions: [`${locator}api/v1/private`],
      allowedActions: ['read', 'analyze'],
    },
    budgets: {
      deadlineAt: '2099-10-02T11:30:00.000Z', maxRequests: 20, maxBytes: 1_000_000, maxToolCalls: 100,
      maxTokens: 10_000, maxCostUsd: 10, maxAttempts: 3, maxTasks: 8, maxDepth: 3, maxConcurrency: 3,
      reportReserveMs: 60_000, targetRequestLimits: { [TARGET]: 12, 'lab-source': 2 },
    },
    requestedRuntime: {
      adapter: 'headless', selection: { provider: 'scripted', model: 'scripted-author', thinking: 'off' },
      requiredCapabilities: [],
    },
    allowedCapabilities: ['http.request', 'source.analyze'],
  };
  const envelope: PlanRequestEnvelope = {
    targets: [{ id: TARGET, kind: 'web', locator }, { id: 'lab-source', kind: 'artifact', locator: 'lab-server.mjs' }],
    taskGrants: [{ taskId: TASK, targetIds: [TARGET], allowedActions: ['read'], allowedCapabilities: ['http.request'] }],
    accounts: ['anonymous'],
    accountGrants: [{ accountId: 'anonymous', targetIds: [TARGET], actions: ['read'] }],
    allowedCapabilities: ['http.request'],
    allowedActions: ['read'],
    exclusions: [{ origin, pathPrefixes: ['/api/v1/private'] }],
  };
  const taskFor = (taskId: string) => taskId === TASK
    ? { question: { text: 'Does the item read route authorize on the client-supplied tenant parameter?' }, surfaceId: 'items-read', actorId: 'acct-guest' }
    : undefined;

  /** The scripted author writes concrete bytes only; it has no approval, no grant and no tool access. */
  const authored = {
    schemaVersion: 1, proposalId: 'reqplan-demo', runId: run.runId,
    requests: [{
      requestId: 'req-1', taskId: TASK, tool: 'http.request', method: 'GET',
      url: `${origin}${NEW_URL_PATH}`, action: 'read', accountId: 'anonymous',
      expectation: { type: 'http', status: 200, bodyIncludes: 'beta-secret' },
      kind: 'test', classification: 'hypothesis',
      summary: 'Read a cross-tenant item the owner menu never enumerated',
      purpose: 'A new item id and tenant query decide whether the read route authorizes on the client parameter',
      requests: 1,
    }],
  };

  const clock = () => Date.parse(NOW);
  const commit = async (): Promise<{ digest: string; proposalId: string; proposal: PlanRequestProposal; ledger: RequestPlanLedger; document: PlanRequestApprovalDocument; refusals: Array<{ step: string; code: string }> }> => {
    const store = createRequestPlanLedger({
      controlRoot, authority: createRequestApprovalAuthority({ approvals: [], now: clock }), clock,
    });
    const stored = store.propose({
      packet: authored, run, envelope, generatorAttemptId: 'demo-author-1', generatorKind: 'scripted',
      requestedSelection: run.requestedRuntime.selection, producedAt: NOW,
    });
    if (!stored.ok) throw new Error(`scripted author proposal was rejected: ${stored.code} ${stored.issues.map(issue => issue.message).join('; ')}`);
    check(stored.record.proposal.requests[0]!.url === `${origin}${NEW_URL_PATH}`, 'the stored proposal lost the authored URL');
    const document: PlanRequestApprovalDocument = {
      version: 1, approvalId: 'req-approval-demo', proposalId: stored.record.proposalId,
      proposalDigest: stored.record.digest, runId: run.runId,
      approvedBy: SCRIPTED_OWNER, reference: 'demo-owner-request-approval', approvedAt: NOW,
      expiresAt: APPROVAL_EXPIRY, requestCount: stored.record.proposal.requests.length,
    };
    // The owner gate holds only the owner's own copy. Until that copy exists, nothing can be approved.
    const gate = createRequestApprovalAuthority({ approvals: [document], now: clock });
    const ledger = createRequestPlanLedger({ controlRoot, authority: gate, clock });

    const refusals: Array<{ step: string; code: string }> = [];
    const refusalCode = async (step: string, work: () => { ok: boolean; code?: string } | Promise<{ ok: boolean; code?: string }>): Promise<void> => {
      const outcome = await work();
      if (outcome.ok) { reasons.add(`${step} unexpectedly succeeded`); return; }
      refusals.push({ step, code: outcome.code ?? 'unknown' });
    };
    // 1. Before approval: no checks, no request. 2. Self/foreign documents are denied by the owner gate.
    await refusalCode('materialize before approval', () => ledger.materialize({ run, proposalDigest: stored.record.digest, envelope, taskFor, now: NOW }));
    await refusalCode('approval signed by the author', () => ledger.approve({ run, proposalDigest: stored.record.digest, document: { ...document, approvedBy: SCRIPTED_AUTHOR } }));
    // 3. A mutated URL is still in scope, so it stores under a DIFFERENT digest and the approved document
    //    cannot bind it. An out-of-scope account/origin/excluded path is refused before storage.
    const mutationLedger = createRequestPlanLedger({ controlRoot: mutationRoot, authority: createRequestApprovalAuthority({ approvals: [], now: clock }), clock });
    const mutatedUrl = mutationLedger.propose({
      packet: { ...authored, proposalId: 'reqplan-demo-mutated-url', requests: [{ ...authored.requests[0]!, url: `${origin}/api/v1/items/i-200?tenant=gamma` }] },
      run, envelope, generatorAttemptId: 'demo-author-1', generatorKind: 'scripted', requestedSelection: run.requestedRuntime.selection, producedAt: NOW,
    });
    if (mutatedUrl.ok) {
      check(mutatedUrl.record.digest !== stored.record.digest, 'a mutated URL did not change the proposal digest');
      const bound = (() => {
        try { materializeRequestPlan(mutatedUrl.record.proposal, { run, approval: { allowed: true, digest: stored.record.digest, proposalId: stored.record.proposalId, proposalDigest: stored.record.digest, approvalId: document.approvalId, approvalDocumentDigest: digestJson(document), authorizationRef: run.authorization.reference, approvedBy: document.approvedBy, reference: document.reference, expiresAt: document.expiresAt }, document, envelope, taskFor, now: NOW }); return { ok: true }; }
        catch (error) { return { ok: false, code: error instanceof Error && 'code' in error ? String(error.code) : 'unknown' }; }
      })();
      await refusalCode('materialize old approval over mutated URL', () => bound);
    } else {
      reasons.add(`mutated URL proposal was refused: ${mutatedUrl.code}`);
    }
    await refusalCode('propose mutated (unapproved) account', () => mutationLedger.propose({
      packet: { ...authored, proposalId: 'reqplan-demo-mutated-account', requests: [{ ...authored.requests[0]!, accountId: 'foreign' }] },
      run, envelope, generatorAttemptId: 'demo-author-1', generatorKind: 'scripted', requestedSelection: run.requestedRuntime.selection, producedAt: NOW,
    }));
    await refusalCode('propose off-scope origin', () => mutationLedger.propose({
      packet: { ...authored, proposalId: 'reqplan-demo-offscope', requests: [{ ...authored.requests[0]!, url: 'http://127.0.0.1:1/api/v1/items/i-200?tenant=beta' }] },
      run, envelope, generatorAttemptId: 'demo-author-1', generatorKind: 'scripted', requestedSelection: run.requestedRuntime.selection, producedAt: NOW,
    }));
    await refusalCode('propose owner-excluded path', () => mutationLedger.propose({
      packet: { ...authored, proposalId: 'reqplan-demo-excluded', requests: [{ ...authored.requests[0]!, url: `${origin}${EXCLUDED_PATH}` }] },
      run, envelope, generatorAttemptId: 'demo-author-1', generatorKind: 'scripted', requestedSelection: run.requestedRuntime.selection, producedAt: NOW,
    }));
    return { digest: stored.record.digest, proposalId: stored.record.proposalId, proposal: stored.record.proposal, ledger, document, refusals };
  };

  try {
    const authoredResult = await commit();
    if (hits.length !== 0) reasons.add(`the fixture was contacted ${hits.length} time(s) before approval`);
    // The owner gate now applies: the named scripted approval approves exactly this digest.
    const approval = await authoredResult.ledger.approve({ run, proposalDigest: authoredResult.digest, document: authoredResult.document });
    if (!approval.ok) throw new Error(`approved fixture document was refused: ${approval.code} ${approval.issues.map(issue => issue.message).join('; ')}`);
    const materialized = authoredResult.ledger.materialize({ run, proposalDigest: authoredResult.digest, envelope, taskFor, now: NOW });
    if (!materialized.ok) throw new Error(`approved proposal did not materialize: ${materialized.code} ${materialized.issues.map(issue => issue.message).join('; ')}`);
    const materializedCheck = materialized.plan.checks[0]!;
    log(`materialized check=${materializedCheck.checkId} observation=${materializedCheck.observationId} tool=${materializedCheck.tool} target=${materialized.plan.grants[0]!.targetId}`);
    check(planRequestProposalDigest(authoredResult.proposal) === authoredResult.digest, 'the stored proposal digest is not stable');
    check(validatePlanRequestProposal(authoredResult.proposal, { run, envelope }).length === 0, 'the validated proposal no longer passes the envelope');

    const sandbox = createLocalFixtureSandbox({ inputRoot, outputRoot, trustedInputSnapshot: true, acknowledgement: 'local-fixtures-only-not-hostile-code-isolation' });
    const policy = createPolicy({
      version: 1, runId: run.runId,
      authorization: { reference: run.authorization.reference, approvedBy: 'demo-owner', notBefore: NOW, expiresAt: POLICY_EXPIRY },
      targets: [{
        id: TARGET, origins: [origin], pathPrefixes: ['/'], allowedCidrs: ['127.0.0.0/8'], excludedCidrs: [],
        methods: ['GET', 'HEAD', 'OPTIONS'], actions: ['read'], accounts: ['anonymous'],
        limits: { maxRequests: 20, maxBytes: 1_000_000, maxConcurrent: 2, rate: { requests: 100, windowMs: 1_000 } },
      }],
      exclusions: [{ origin, pathPrefixes: ['/api/v1/private'] }],
      accounts: [{ id: 'anonymous', targetIds: [TARGET], actions: ['read'], expiresAt: POLICY_EXPIRY, kind: 'anonymous' }],
      grants: [{
        id: 'demo-grant', taskId: TASK, attemptId: 'demo-attempt', role: 'worker',
        capabilities: ['http.request'], targetIds: [TARGET], actions: ['read'], accountIds: ['anonymous'],
        expiresAt: POLICY_EXPIRY, maxCalls: 20, maxArtifactBytes: 1_000_000,
      }],
    } as unknown as Scope);
    const broker = createToolBroker({ policy, budgets: new TargetBudget(policy.scope.targets), sandbox });
    const result = await broker.execute({ context: { runId: run.runId, taskId: TASK, attemptId: 'demo-attempt', grantId: 'demo-grant' }, tool: materializedCheck.tool, input: materializedCheck.input });
    const evidence = result.data as HttpEvidence;
    const hitsAfter = hits.filter(hit => hit.startsWith('/api/v1/items/i-200')).length;
    check(evidence.status === 200 && evidence.body.includes('beta-secret'), `broker execution returned status=${evidence.status}`);
    check(hitsAfter === 1, `the new path was hit ${hitsAfter} time(s), expected exactly 1`);
    check(hits.every(hit => !hit.startsWith('/api/v1/items/i-100')), 'the original owner-observation route was contacted');
    const artifact = readFileSync(join(outputRoot, result.artifact.path), 'utf8');
    check(artifact.includes('beta-secret'), 'the collected artifact is missing the fixture body');

    // Restart/replay: a fresh ledger and the same owner copy converge on identical identities.
    const restarted = createRequestPlanLedger({ controlRoot, authority: createRequestApprovalAuthority({ approvals: [authoredResult.document], now: clock }), clock });
    const replayed = await restarted.approve({ run, proposalDigest: authoredResult.digest, document: authoredResult.document });
    const replayPlan = restarted.materialize({ run, proposalDigest: authoredResult.digest, envelope, taskFor, now: NOW });
    const read = restarted.read(run.runId);
    const replayState = {
      proposals: read.proposals.length,
      approvals: read.approvals.length,
      duplicateApproval: replayed.ok && replayed.duplicate,
      identicalIdentities: replayPlan.ok && JSON.stringify(replayPlan.plan.checks) === JSON.stringify(materialized.plan.checks),
    };
    check(replayState.proposals === 1 && replayState.approvals === 1 && replayState.duplicateApproval && replayState.identicalIdentities, 'restart/replay was not idempotent');

    return {
      origin, proposalId: authoredResult.proposalId, digest: authoredResult.digest, newUrl: `${origin}${NEW_URL_PATH}`,
      refusals: authoredResult.refusals,
      execution: { status: evidence.status, bodyHasSecret: evidence.body.includes('beta-secret'), pinnedAddress: evidence.hops[0]!.pinnedAddress },
      replay: replayState,
      acceptance: { ok: reasons.size === 0, reasons: [...reasons] },
    };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}
