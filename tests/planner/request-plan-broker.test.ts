import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPolicy, TargetBudget, type Scope } from '../../src/policy/index.js';
import { createLocalFixtureSandbox, createToolBroker, type HttpEvidence, type ToolBroker } from '../../src/tools/index.js';
import { materializeRequestPlan, type MaterializedRequestPlan } from '../../src/application/planner.js';
import { createRequestPlanLedger } from '../../src/application/planner.js';
import { createRequestApprovalAuthority } from '../../src/application/authority.js';
import { digestJson } from '../../src/contracts/index.js';
import {
  NOW, NEW_PATH, ORIGINAL_PATH, REQUEST_TASK,
  createRequestHarness, requestDraft, requestPacket, requestScope, requestTaskFor, startLabServer,
  type LabServer, type RequestHarness,
} from './request-fixtures.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function labAndHarness(): Promise<{ server: LabServer; harness: RequestHarness; sandboxRoot: string; broker: ToolBroker }> {
  const server = await startLabServer();
  cleanups.push(() => server.close());
  const harness = createRequestHarness({ origin: server.origin });
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'p2o-request-broker-'));
  cleanups.push(() => rmSync(sandboxRoot, { recursive: true, force: true }));
  const inputRoot = join(sandboxRoot, 'inputs');
  const outputRoot = join(sandboxRoot, 'outputs');
  mkdirSync(inputRoot, { recursive: true, mode: 0o700 });
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const sandbox = createLocalFixtureSandbox({
    inputRoot, outputRoot, trustedInputSnapshot: true,
    acknowledgement: 'local-fixtures-only-not-hostile-code-isolation',
  });
  const policy = createPolicy(requestScope(harness.run, server.origin) as unknown as Scope);
  const broker = createToolBroker({ policy, budgets: new TargetBudget(policy.scope.targets), sandbox });
  return { server, harness, sandboxRoot, broker };
}

const context = { runId: 'run-request-1', taskId: REQUEST_TASK, attemptId: 'attempt-request-1', grantId: 'grant-request-1' };

async function executePlan(broker: ToolBroker, plan: MaterializedRequestPlan): Promise<HttpEvidence> {
  const check = plan.checks[0]!;
  const result = await broker.execute({ context, tool: check.tool, input: check.input });
  return result.data as HttpEvidence;
}

describe('generated requests execute through the real broker only after exact-digest owner approval', () => {
  it('a NEW path and query executes once approved, and sends nothing before approval', async () => {
    const { server, harness, broker } = await labAndHarness();
    const newPathHits = () => server.hits.filter(hit => hit.url.startsWith('/api/v1/items/i-200'));
    expect(newPathHits()).toHaveLength(0);

    // 1. The unapproved proposal cannot materialize: no check exists and the target is never touched.
    const unapproved = harness.materialize();
    expect(unapproved.ok).toBe(false);
    if (!unapproved.ok) expect(unapproved.code).toBe('request-plan-unapproved');
    expect(harness.proposeAgain().ok).toBe(true); // propose is inert too
    expect(newPathHits()).toHaveLength(0);

    // 2. Owner approval of the exact digest materializes a digest-bound check and grant.
    const approved = await harness.approve();
    expect(approved.ok).toBe(true);
    const plan = harness.materialize();
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.plan.checks).toHaveLength(1);
    expect(plan.plan.grants[0]!.targetId).toBe('lab-web');
    expect(plan.plan.grants[0]!.url).toBe(`${server.origin}${NEW_PATH}`);
    expect(plan.plan.grants[0]!.urlDigest).toBe(digestJson(plan.plan.grants[0]!.url));
    expect(plan.plan.grants[0]!.proposalDigest).toBe(harness.digest);
    expect(plan.plan.grants[0]!.accountId).toBe('anonymous');
    expect(plan.plan.grants[0]!.action).toBe('read');
    expect(plan.plan.checks[0]!.tool).toBe('http.request');

    // 3. The materialized check executes through the real broker against the local fixture.
    const evidence = await executePlan(broker, plan.plan);
    expect(evidence.status).toBe(200);
    expect(evidence.body).toContain('beta-secret');
    expect(evidence.hops[0]!.pinnedAddress).toBe('127.0.0.1');
    expect(newPathHits()).toHaveLength(1);
    // The controller expectation is evaluated over the collected bytes.
    expect(plan.plan.checks[0]!.expectation).toEqual({ type: 'http', status: 200, bodyIncludes: 'beta-secret' });
    expect(evidence.status).toBe(200);
    expect(evidence.body.includes('beta-secret')).toBe(true);
    // The original owner-observation route was never needed for the new claim.
    expect(server.hits.filter(hit => hit.url.includes('i-100'))).toHaveLength(0);
  });

  it('mutated URL, headers or account move the digest; the old approval cannot bind or execute the mutated bytes', async () => {
    const { server, harness, broker } = await labAndHarness();
    const approved = await harness.approve();
    expect(approved.ok).toBe(true);
    const approval = await harness.ownerApproval();
    const originals = (await harness.materialize());
    expect(originals.ok).toBe(true);
    if (!originals.ok) return;
    await executePlan(broker, originals.plan);
    const originalHits = server.hits.length;

    const mutations: Array<[string, Record<string, unknown>]> = [
      ['url', { url: `${server.origin}/api/v1/items/i-200?tenant=gamma` }],
      ['headers', { headers: { 'if-none-match': 'v2' } }],
      ['account', { accountId: 'acct-guest' }],
    ];
    for (const [label, overrides] of mutations) {
      const mutated = harness.ledger.propose({
        packet: requestPacket(harness.run, server.origin, { proposalId: `reqplan-e2e-${label}`, requests: [{ ...requestDraft(server.origin), ...overrides }] }),
        run: harness.run, envelope: harness.envelope, generatorAttemptId: 'gen-2', generatorKind: 'scripted',
        requestedSelection: harness.run.requestedRuntime.selection, producedAt: NOW,
      });
      expect(mutated.ok).toBe(true);
      if (!mutated.ok) continue;
      expect(mutated.record.digest).not.toBe(harness.digest);
      expect(() => materializeRequestPlan(mutated.record.proposal, {
        run: harness.run, approval, document: harness.document, envelope: harness.envelope, taskFor: requestTaskFor, now: NOW,
      })).toThrow(/request-plan-approval-binding/);
      const unapproved = harness.ledger.materialize({
        run: harness.run, proposalDigest: mutated.record.digest, envelope: harness.envelope, taskFor: requestTaskFor, now: NOW,
      });
      expect(unapproved.ok).toBe(false);
      if (!unapproved.ok) expect(unapproved.code).toBe('request-plan-unapproved');
    }
    // Only the approved original request reached the fixture; the mutated variants never did.
    expect(server.hits.length).toBe(originalHits);
    expect(server.hits.some(hit => hit.url.includes('tenant=gamma'))).toBe(false);
    // An off-scope account is refused at proposal time, before any dispatch path exists.
    const foreign = harness.ledger.propose({
      packet: requestPacket(harness.run, server.origin, { proposalId: 'reqplan-e2e-foreign', requests: [{ ...requestDraft(server.origin), accountId: 'foreign' }] }),
      run: harness.run, envelope: harness.envelope, generatorAttemptId: 'gen-3', generatorKind: 'scripted',
      requestedSelection: harness.run.requestedRuntime.selection, producedAt: NOW,
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.code).toBe('request-plan-account');
    expect(server.hits.length).toBe(originalHits);
  });

  it('off-scope origins and owner-excluded paths are refused and never contacted', async () => {
    const { server, harness } = await labAndHarness();
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['origin', { url: 'http://127.0.0.1:1/api/v1/items/i-200?tenant=beta' }, 'request-plan-target'],
      ['excluded', { url: `${server.origin}/api/v1/private/i-200?tenant=beta` }, 'request-plan-target'],
      ['wildcard', { url: `${server.origin}/api/v1/items/*` }, 'request-plan-url'],
    ];
    for (const [label, overrides, code] of cases) {
      const outcome = harness.ledger.propose({
        packet: requestPacket(harness.run, server.origin, { proposalId: `reqplan-offscope-${label}`, requests: [{ ...requestDraft(server.origin), ...overrides }] }),
        run: harness.run, envelope: harness.envelope, generatorAttemptId: `gen-${label}`, generatorKind: 'scripted',
        requestedSelection: harness.run.requestedRuntime.selection, producedAt: NOW,
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.issues.map(issue => issue.code)).toContain(code);
    }
    expect(server.hits).toHaveLength(0);
  });

  it('restart/replay is idempotent: one approval record, identical identities, one request per execution', async () => {
    const { server, harness, sandboxRoot, broker } = await labAndHarness();
    const first = await harness.approve();
    expect(first.ok).toBe(true);
    const replay = await harness.approve();
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.duplicate).toBe(true);
    const before = harness.materialize();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const restarted = createRequestPlanLedger({
      controlRoot: harness.controlRoot,
      authority: createRequestApprovalAuthority({ approvals: [harness.document], now: () => Date.parse(NOW) }),
      clock: () => Date.parse(NOW),
    });
    const read = restarted.read(harness.run.runId);
    expect(read.proposals).toHaveLength(1);
    expect(read.approvals).toHaveLength(1);
    const after = restarted.materialize({ run: harness.run, proposalDigest: harness.digest, envelope: harness.envelope, taskFor: requestTaskFor, now: NOW });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.plan.checks).toEqual(before.plan.checks);
    expect(after.plan.grants).toEqual(before.plan.grants);
    // Re-materialization is identity-stable; each explicit execution is exactly one bounded request.
    const firstEvidence = await executePlan(broker, before.plan);
    const secondEvidence = await executePlan(broker, after.plan);
    expect(firstEvidence.body).toBe(secondEvidence.body);
    expect(server.hits.filter(hit => hit.url === `${NEW_PATH}` || hit.url.startsWith('/api/v1/items/i-200'))).toHaveLength(2);
    // The original owner observation was never executed by this generated path.
    expect(server.hits.some(hit => hit.url.startsWith(ORIGINAL_PATH))).toBe(false);
    const receipt = await broker.execute({ context, tool: before.plan.checks[0]!.tool, input: before.plan.checks[0]!.input });
    expect(receipt.receipt.targets).toContain('lab-web');
    expect(receipt.receipt.classification).toBe('observation-not-verified-finding');
    const artifact = readFileSync(join(sandboxRoot, 'outputs', receipt.artifact.path), 'utf8');
    expect(artifact).toContain('beta-secret');
  });
});
