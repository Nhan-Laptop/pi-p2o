import { describe, expect, it } from 'vitest';
import { assertOwnerGrant, createRequestApprovalAuthority } from '../../src/application/authority.js';
import { createRequestPlanLedger, materializeRequestPlan } from '../../src/application/planner.js';
import { digestJson } from '../../src/contracts/index.js';
import { planRequestProposalDigest, validatePlanRequestProposal } from '../../src/contracts/plan-request.js';
import {
  NOW, APPROVAL_EXPIRY, ORIGINAL_PATH, REQUEST_TASK,
  createRequestHarness, ownerAuthorityFor, ownerGrantWithRequestApprovals, requestDraft, requestEnvelope,
  requestPacket, requestRun, requestTaskFor,
} from './request-fixtures.js';

/** Model-authored packet: the request set only; the ledger injects and verifies the generator provenance. */

describe('generated request proposals: model-authored requests, owner batch approval', () => {
  it('proposes a NEW path and query no owner observation enumerated, sealed by the canonical digest', () => {
    const h = createRequestHarness();
    const draft = h.stored.proposal.requests[0]!;
    expect(draft.url).toContain('i-200?tenant=beta');
    expect(draft.url).not.toContain(ORIGINAL_PATH);
    expect(h.stored.digest).toBe(planRequestProposalDigest(h.stored.proposal));
    expect(h.stored.proposal.generator.generatorKind).toBe('scripted');
    expect(h.stored.proposal.generator.packetDigest).toBe(digestJson(h.packet));
    // The canonical digest covers the concrete input, including the new query.
    const changed = { ...h.stored.proposal, requests: [{ ...draft, url: `${h.origin}/api/v1/items/i-200?tenant=gamma` }] };
    expect(planRequestProposalDigest(changed)).not.toBe(h.digest);
    // Replaying the identical packet is idempotent: same record, same digest.
    const again = h.proposeAgain();
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.record.digest).toBe(h.digest);
      expect(again.record.proposalId).toBe(h.stored.proposalId);
    }
  });

  it('refuses scripts, shells, arbitrary tools and any unknown field at the schema', () => {
    const h = createRequestHarness();
    const issuesFor = (overrides: Record<string, unknown>) => validatePlanRequestProposal(
      { ...h.stored.proposal, requests: [{ ...requestDraft(h.origin), ...overrides }] },
      { run: h.run, envelope: h.envelope },
    );
    for (const overrides of [{ shell: 'curl http://evil.test' }, { command: 'sh -c whoami' }, { script: 'process.exit(0)' }, { tool: 'process.exec' }]) {
      const issues = issuesFor(overrides);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]!.code).toBe('request-plan-schema');
    }
  });

  it('refuses off-scope origins, owner exclusions, unapproved accounts, mislabelled actions, bodies on reads, forbidden headers and over-budget sets', () => {
    const h = createRequestHarness();
    const codesFor = (overrides: Record<string, unknown>): string[] => validatePlanRequestProposal(
      { ...h.stored.proposal, requests: [{ ...requestDraft(h.origin), ...overrides }] },
      { run: h.run, envelope: h.envelope },
    ).map(issue => issue.code);
    expect(codesFor({ url: 'http://127.0.0.1:1/api/v1/items/i-200?tenant=beta' })).toContain('request-plan-target');
    expect(codesFor({ url: `${h.origin}/api/v1/private/i-200` })).toContain('request-plan-target');
    expect(codesFor({ accountId: 'foreign' })).toContain('request-plan-account');
    expect(codesFor({ method: 'POST', action: 'read' })).toContain('request-plan-action');
    expect(codesFor({ method: 'POST', action: 'mutate' })).toContain('request-plan-action');
    expect(codesFor({ body: '{"note":"x"}' })).toContain('request-plan-body');
    expect(codesFor({ headers: { authorization: 'Bearer worker-secret' } })).toContain('request-plan-header');
    expect(codesFor({ headers: { host: 'outside.test' } })).toContain('request-plan-header');
    expect(codesFor({ body: '{"password":"x"}', method: 'POST', action: 'mutate' })).toContain('request-plan-body');
    expect(codesFor({ requests: 99 })).toContain('request-plan-budget');
    expect(codesFor({ url: `${h.origin}/api/v1/items/*` })).toContain('request-plan-url');
    expect(codesFor({ url: `${h.origin}/api/v1/items/i-200?tenant=beta#fragment` })).toContain('request-plan-url');
    // The same URL under a target the task does not scope is refused too.
    const issues = validatePlanRequestProposal(
      { ...h.stored.proposal, requests: [{ ...requestDraft(h.origin), taskId: 'task-other' }] },
      { run: h.run, envelope: h.envelope },
    );
    expect(issues.map(issue => issue.code)).toContain('request-plan-task');
  });

  it('cannot self-approve: only the owner grant copy of the exact document authorizes and the ledger never dispatches', async () => {
    const h = createRequestHarness({ grantOwnerApproval: false });
    const forged = { ...h.document, approvedBy: 'model', reference: 'self-approved-by-the-model' };
    const denied = await h.ledger.approve({ run: h.run, proposalDigest: h.digest, document: forged });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe('permission-denied');
    const unapproved = h.materialize();
    expect(unapproved.ok).toBe(false);
    if (!unapproved.ok) expect(unapproved.code).toBe('request-plan-unapproved');
    // The owner authority exposes no append path: its own copy approves, a forged one is denied.
    const owner = ownerAuthorityFor(h.run, [h.document]);
    const approval = await owner.approveRequestProposal(h.stored.proposal, h.document, {
      runId: h.run.runId, now: NOW, authorizationRef: h.run.authorization.reference,
    });
    expect(approval.allowed).toBe(true);
    expect(approval.proposalDigest).toBe(h.digest);
    expect(approval.approvalDocumentDigest).toBe(digestJson(h.document));
    await expect(owner.approveRequestProposal(h.stored.proposal, forged, {
      runId: h.run.runId, now: NOW, authorizationRef: h.run.authorization.reference,
    })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('a forged document cannot materialize even when it names the approved proposal digest', async () => {
    const h = createRequestHarness();
    await h.approve();
    const genuine = await h.ownerApproval();
    expect(h.materializedPlan(genuine).checks).toHaveLength(1);
    const forged = { ...h.document, approvalId: 'forged-approval', approvedBy: 'model' };
    const forgedApproval = { ...genuine, approvalId: 'forged-approval', approvalDocumentDigest: digestJson(forged) };
    expect(() => h.materializedPlan(forgedApproval)).toThrow(/request-plan-approval-binding/);
    // The ledger only ever materializes the approval it recorded from the owner gate.
    const outcome = h.materialize();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.plan.checks).toHaveLength(1);
  });

  it('mutation of the URL, body or account moves the digest and the old approval cannot bind the mutated bytes', async () => {
    const h = createRequestHarness();
    const approved = await h.approve();
    expect(approved.ok).toBe(true);
    const mutations: Array<[string, Record<string, unknown>]> = [
      ['url', { url: `${h.origin}/api/v1/items/i-200?tenant=gamma` }],
      ['headers', { headers: { 'if-none-match': 'v2' } }],
      ['account', { accountId: 'acct-guest' }],
    ];
    for (const [label, overrides] of mutations) {
      const mutatedPacket = requestPacket(h.run, h.origin, {
        proposalId: `reqplan-mutated-${label}`,
        requests: [{ ...requestDraft(h.origin), ...overrides }],
      });
      const stored = h.ledger.propose({
        packet: mutatedPacket, run: h.run, envelope: h.envelope, generatorAttemptId: 'gen-2', generatorKind: 'scripted',
        requestedSelection: h.run.requestedRuntime.selection, producedAt: NOW,
      });
      expect(stored.ok).toBe(true);
      if (!stored.ok) continue;
      expect(stored.record.digest).not.toBe(h.digest);
      const approval = await h.ownerApproval();
      expect(() => materializeRequestPlan(stored.record.proposal, {
        run: h.run, approval, document: h.document, envelope: h.envelope, taskFor: requestTaskFor, now: NOW,
      })).toThrow(/request-plan-approval-binding/);
      const byDigest = h.ledger.materialize({
        run: h.run, proposalDigest: stored.record.digest, envelope: h.envelope, taskFor: requestTaskFor, now: NOW,
      });
      expect(byDigest.ok).toBe(false);
      if (!byDigest.ok) expect(byDigest.code).toBe('request-plan-unapproved');
    }
    // The unmutated original still materializes and executes under its own approval.
    const original = h.materialize();
    expect(original.ok).toBe(true);
    if (original.ok) expect(original.plan.grants[0]!.url).toContain('tenant=beta');
  });

  it('mutating only the bounded body of an owner-granted mutate request invalidates the approval', async () => {
    const h = createRequestHarness();
    const mutateRun = { ...h.run, authorization: { ...h.run.authorization, allowedActions: ['read', 'analyze', 'mutate'] } };
    const mutateEnvelope = {
      ...h.envelope,
      taskGrants: [{ taskId: REQUEST_TASK, targetIds: ['lab-web'], allowedActions: ['read', 'mutate'], allowedCapabilities: ['http.request'] }],
      allowedActions: ['read', 'mutate'],
      accountGrants: h.envelope.accountGrants?.map(account => ({ ...account, actions: ['read', 'mutate'] })),
    };
    const draft = { ...requestDraft(h.origin), method: 'POST', action: 'mutate', body: JSON.stringify({ note: 'v1' }) };
    const first = h.ledger.propose({
      packet: requestPacket(mutateRun, h.origin, { proposalId: 'reqplan-body-1', requests: [draft] }),
      run: mutateRun, envelope: mutateEnvelope, generatorAttemptId: 'gen-body', generatorKind: 'scripted',
      requestedSelection: mutateRun.requestedRuntime.selection, producedAt: NOW,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const document = {
      version: 1 as const, approvalId: 'body-approval', proposalId: first.record.proposalId,
      proposalDigest: first.record.digest, runId: mutateRun.runId, approvedBy: 'fixture-owner',
      reference: 'owner-request-approval-body', approvedAt: NOW, expiresAt: APPROVAL_EXPIRY, requestCount: 1,
    };
    const gate = createRequestPlanLedger({
      controlRoot: h.controlRoot, authority: createRequestApprovalAuthority({ approvals: [document], now: () => Date.parse(NOW) }), clock: () => Date.parse(NOW),
    });
    const approved = await gate.approve({ run: mutateRun, proposalDigest: first.record.digest, document });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.approval.proposalDigest).toBe(first.record.digest);
    const mutated = gate.propose({
      packet: requestPacket(mutateRun, h.origin, { proposalId: 'reqplan-body-2', requests: [{ ...draft, body: JSON.stringify({ note: 'v2' }) }] }),
      run: mutateRun, envelope: mutateEnvelope, generatorAttemptId: 'gen-body', generatorKind: 'scripted',
      requestedSelection: mutateRun.requestedRuntime.selection, producedAt: NOW,
    });
    expect(mutated.ok).toBe(true);
    if (!mutated.ok) return;
    expect(mutated.record.digest).not.toBe(first.record.digest);
    const plan = gate.materialize({ run: mutateRun, proposalDigest: first.record.digest, envelope: mutateEnvelope, taskFor: requestTaskFor, now: NOW });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect((plan.plan.checks[0]!.input as { body?: string }).body).toBe(JSON.stringify({ note: 'v1' }));
    expect(() => materializeRequestPlan(mutated.record.proposal, {
      run: mutateRun, approval: approved.approval, document, envelope: mutateEnvelope, taskFor: requestTaskFor, now: NOW,
    })).toThrow(/request-plan-approval-binding/);
  });

  it('restart and replay converge on one proposal, one approval, and identical check/grant identities', async () => {
    const h = createRequestHarness();
    const first = await h.approve();
    expect(first.ok).toBe(true);
    const replay = await h.approve();
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.duplicate).toBe(true);
      expect(replay.record.approvalDocumentDigest).toBe(digestJson(h.document));
    }
    const before = h.materialize();
    expect(before.ok).toBe(true);
    // A fresh ledger over the same control root is the restart: state is durable, not in-memory.
    const restarted = createRequestPlanLedger({
      controlRoot: h.controlRoot,
      authority: createRequestApprovalAuthority({ approvals: [h.document], now: () => Date.parse(NOW) }),
      clock: () => Date.parse(NOW),
    });
    const read = restarted.read(h.run.runId);
    expect(read.proposals).toHaveLength(1);
    expect(read.proposals[0]!.digest).toBe(h.digest);
    expect(read.approvals).toHaveLength(1);
    expect(read.approvals[0]!.approvalDocumentDigest).toBe(digestJson(h.document));
    const after = restarted.materialize({ run: h.run, proposalDigest: h.digest, envelope: h.envelope, taskFor: requestTaskFor, now: NOW });
    expect(after.ok).toBe(true);
    if (before.ok && after.ok) {
      expect(after.plan.checks).toEqual(before.plan.checks);
      expect(after.plan.grants).toEqual(before.plan.grants);
      expect(after.plan.grants[0]!.grantId).toBe(before.plan.grants[0]!.grantId);
      expect(after.plan.grants[0]!.urlDigest).toBe(digestJson(before.plan.grants[0]!.url));
    }
    const again = restarted.propose({
      packet: h.packet, run: h.run, envelope: h.envelope, generatorAttemptId: 'gen-1', generatorKind: 'scripted',
      requestedSelection: h.run.requestedRuntime.selection, producedAt: NOW,
    });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.record.digest).toBe(h.digest);
  });

  it('expired and future-dated owner approvals are refused with explicit codes', async () => {
    const h = createRequestHarness();
    const expired = { ...h.document, approvedAt: '2026-10-02T09:00:00.000Z', expiresAt: '2026-10-02T09:30:00.000Z' };
    const authority = createRequestApprovalAuthority({ approvals: [expired], now: () => Date.parse(NOW) });
    const ledger = createRequestPlanLedger({ controlRoot: h.controlRoot, authority, clock: () => Date.parse(NOW) });
    const outcome = await ledger.approve({ run: h.run, proposalDigest: h.digest, document: expired });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('request-plan-approval-expired');
    const future = { ...h.document, approvedAt: '2026-10-02T10:30:00.000Z', expiresAt: '2026-10-02T11:45:00.000Z' };
    const futureLedger = createRequestPlanLedger({
      controlRoot: h.controlRoot,
      authority: createRequestApprovalAuthority({ approvals: [future], now: () => Date.parse(NOW) }),
      clock: () => Date.parse(NOW),
    });
    const early = await futureLedger.approve({ run: h.run, proposalDigest: h.digest, document: future });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.code).toBe('request-plan-approval-future');
  });

  it('the owner grant accepts request approvals structurally and rejects malformed or unknown ones', () => {
    const h = createRequestHarness();
    expect(() => assertOwnerGrant(ownerGrantWithRequestApprovals(h.run, [h.document]))).not.toThrow();
    expect(() => assertOwnerGrant(ownerGrantWithRequestApprovals(h.run, [{ ...h.document, requestCount: 0 }]))).toThrow(/invalid-grant/);
    expect(() => assertOwnerGrant({ ...ownerGrantWithRequestApprovals(h.run, []), unexpected: true })).toThrow(/unknown owner grant field/);
  });

  it('an owner envelope narrowed after approval refuses execution instead of widening scope', async () => {
    const h = createRequestHarness();
    await h.approve();
    const approval = await h.ownerApproval();
    const narrowed = requestEnvelope(h.origin, { taskGrants: [{ taskId: REQUEST_TASK, targetIds: ['lab-source'], allowedActions: ['read'], allowedCapabilities: ['http.request'] }] });
    expect(() => materializeRequestPlan(h.stored.proposal, {
      run: h.run, approval, document: h.document, envelope: narrowed, taskFor: requestTaskFor, now: NOW,
    })).toThrow(/request-plan-envelope-changed/);
    const revoked = requestRun(h.origin, { allowedCapabilities: ['source.analyze'] });
    // The ledger refuses because the stored run manifest is what the caller passes; simulate a policy revocation.
    const outcome = h.ledger.materialize({ run: revoked, proposalDigest: h.digest, envelope: h.envelope, taskFor: requestTaskFor, now: NOW });
    expect(outcome.ok).toBe(false);
  });

  it('deterministic check ids never accept a worker-authored identity as controller authority', async () => {
    const h = createRequestHarness();
    await h.approve();
    const approval = await h.ownerApproval();
    const checkId = `rchk-${digestJson({ kind: 'request-check', proposalDigest: h.digest, requestId: 'req-1' }).slice(0, 32)}`;
    const observationId = `rob-${digestJson({ kind: 'request-observation', proposalDigest: h.digest, requestId: 'req-1' }).slice(0, 32)}`;
    const plan = h.materializedPlan(approval);
    expect(plan.checks[0]!.checkId).toBe(checkId);
    expect(plan.checks[0]!.observationId).toBe(observationId);
    expect(plan.checks[0]!.tool).toBe('http.request');
    expect(plan.grants[0]!.checkId).toBe(checkId);
    expect(plan.grants[0]!.observationId).toBe(observationId);
    expect(plan.grants[0]!.proposalDigest).toBe(h.digest);
  });
});
