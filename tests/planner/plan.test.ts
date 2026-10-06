import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  planProposalDigest, reconcileCoverage, type AttemptRecord, type PlanProposal,
} from '../../src/contracts/index.js';
import { createPlanLedger, createPlanPort, createWorkerContextPort } from '../../src/application/planner.js';
import { createSupervisor } from '../../src/orchestrator/index.js';
import { createOwnerAuthority } from '../../src/application/authority.js';
import { parseCommand, schemas, validate } from '../../src/interface/schemas.js';
import {
  BOUNDARY, NOW, TOOL_POLICY, approvalDocument, createPlanHarness, planProposal, restartSupervisor,
} from './fixtures.js';

const codeIs = (code: string) => (error: unknown): boolean => (error as { code?: string })?.code === code;

/** A fresh planner packet derived from the stored proposal (no injected packet digest). */
const variant = (base: PlanProposal): PlanProposal => {
  const clone = structuredClone(base) as PlanProposal;
  delete clone.provenance.packetDigest;
  return clone;
};

test('p2o_plan is a registered tool and never accepts an approval without a digest and owner file', () => {
  // 14 control-plane actions plus the session-bound p2o_orchestrate foreground surface.
  assert.equal(Object.keys(schemas).length, 15);
  assert.ok(Object.hasOwn(schemas, 'orchestrate'));
  assert.ok(Object.hasOwn(schemas, 'plan'));
  const command = parseCommand('plan', JSON.stringify({ action: 'read', runId: 'run-1' }));
  assert.equal(command.action, 'read');
  assert.throws(() => validate('plan', { action: 'approve', runId: 'run-1' }), /INVALID_INPUT/);
  assert.throws(() => validate('plan', { action: 'propose', runId: 'run-1' }), /INVALID_INPUT/);
  assert.throws(() => validate('plan', { action: 'read', runId: 'run-1', approvalPath: '/tmp/a.json' }), /INVALID_INPUT/);
  const approve = validate('plan', { action: 'approve', runId: 'run-1', proposalDigest: 'a'.repeat(64), approvalPath: '/tmp/a.json' });
  assert.equal(approve.action, 'approve');
});

test('over-cap, over-depth, over-observation and over-budget proposals are rejected with explicit codes', async () => {
  const h = await createPlanHarness();
  try {
    const overTasks = variant(h.proposal);
    overTasks.proposalId = 'plan-over-tasks';
    overTasks.caps.maxTasks = 1;
    overTasks.tasks.push({ ...structuredClone(overTasks.tasks[0]!), taskId: 'task-2' });
    overTasks.coverage.push({ ...structuredClone(overTasks.coverage[0]!), cellId: 'cell-2', taskId: 'task-2' });
    const overTaskCount = h.ledger.propose({ packet: overTasks, run: h.run, plannerAttemptId: 'planner-1' });
    assert.equal(overTaskCount.ok, false);
    assert.equal(overTaskCount.ok ? '' : overTaskCount.code, 'plan-task-count');

    const deep = variant(h.proposal);
    deep.proposalId = 'plan-deep';
    deep.caps.maxDepth = 0;
    deep.tasks[0]!.depth = 1;
    const overDepth = h.ledger.propose({ packet: deep, run: h.run, plannerAttemptId: 'planner-1' });
    assert.equal(overDepth.ok, false);
    assert.equal(overDepth.ok ? '' : overDepth.code, 'plan-depth');

    const manyObservations = variant(h.proposal);
    manyObservations.proposalId = 'plan-many-observations';
    manyObservations.caps.maxObservations = 1;
    manyObservations.observations.push({ ...structuredClone(manyObservations.observations[0]!), observationId: 'obs-2' });
    const overObservations = h.ledger.propose({ packet: manyObservations, run: h.run, plannerAttemptId: 'planner-1' });
    assert.equal(overObservations.ok, false);
    assert.equal(overObservations.ok ? '' : overObservations.code, 'plan-observation-count');

    const overBudget = variant(h.proposal);
    overBudget.proposalId = 'plan-over-budget';
    overBudget.observations[0]!.requests = 9;
    const overRequests = h.ledger.propose({ packet: overBudget, run: h.run, plannerAttemptId: 'planner-1' });
    assert.equal(overRequests.ok, false);
    assert.equal(overRequests.ok ? '' : overRequests.code, 'plan-request-budget');

    const outsideScope = variant(h.proposal);
    outsideScope.proposalId = 'plan-outside-scope';
    outsideScope.observations[0]!.input = { url: 'https://unapproved.example/health' };
    const outside = h.ledger.propose({ packet: outsideScope, run: h.run, plannerAttemptId: 'planner-1' });
    assert.equal(outside.ok, false);
    assert.equal(outside.ok ? '' : outside.code, 'plan-observation-target');

    assert.ok(h.ledger.rejections(h.run.runId).length >= 5);
    assert.equal(h.store.listTasks(h.run.runId).length, 0);
  } finally { h.store.close(); }
});

test('an unapproved proposal admits no task', async () => {
  const h = await createPlanHarness({ grantPlanApproval: false });
  try {
    const denied = await h.ledger.approve({ run: h.run, proposalDigest: h.digest, document: h.approvalDocument });
    assert.equal(denied.ok, false);
    assert.equal(denied.ok ? '' : denied.code, 'permission-denied');
    await assert.rejects(() => h.supervisor.admitPlan!(h.batch()), codeIs('permission-denied'));
    assert.equal(h.store.listTasks(h.run.runId).length, 0);
    assert.equal(h.ledger.approvedCells(h.run.runId).length, 0);
  } finally { h.store.close(); }
});

test('an approved batch admits its tasks once and replays idempotently across restart', async () => {
  const h = await createPlanHarness();
  try {
    const approved = await h.ledger.approve({ run: h.run, proposalDigest: h.digest, document: h.approvalDocument });
    assert.equal(approved.ok, true);
    const first = await h.supervisor.admitPlan!(h.batch());
    assert.deepEqual(first.map(task => task.taskId), ['task-1']);
    assert.equal(h.store.listTasks(h.run.runId).length, 1);
    const replay = await h.supervisor.admitPlan!(h.batch());
    assert.deepEqual(replay.map(task => task.taskId), ['task-1']);
    assert.equal(h.store.listTasks(h.run.runId).length, 1);
    const restarted = restartSupervisor(h);
    const afterCrash = await restarted.admitPlan!(h.batch());
    assert.equal(afterCrash.length, 1);
    assert.equal(h.store.listTasks(h.run.runId).length, 1);

    const freshLedger = createPlanLedger({ controlRoot: h.controlRoot, authority: h.authority, clock: () => h.clock.now() });
    const repeated = await freshLedger.approve({ run: h.run, proposalDigest: h.digest, document: h.approvalDocument });
    assert.ok(repeated.ok && repeated.duplicate === true);
    assert.equal(freshLedger.approvedCells(h.run.runId).length, 1);
    assert.ok(h.store.listEvents({ runId: h.run.runId }).filter(event => event.type === 'orchestrator.plan-admitted').length >= 3);
  } finally { h.store.close(); }
});

test('a proposal mutated after approval is refused by the ledger, the authority and admission', async () => {
  const h = await createPlanHarness();
  try {
    const approved = await h.ledger.approve({ run: h.run, proposalDigest: h.digest, document: h.approvalDocument });
    assert.equal(approved.ok, true);
    const planFile = join(h.controlRoot, 'plans', `${h.proposal.proposalId}.json`);
    const record = JSON.parse(readFileSync(planFile, 'utf8')) as { proposal: PlanProposal };
    record.proposal.tasks[0]!.surface = 'Tampered surface label after owner approval';
    writeFileSync(planFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });

    const refused = await h.ledger.approve({ run: h.run, proposalDigest: h.digest, document: h.approvalDocument });
    assert.equal(refused.ok, false);
    assert.equal(refused.ok ? '' : refused.code, 'plan-digest-mismatch');

    const mutated = variant(h.proposal);
    mutated.tasks[0]!.surface = 'Tampered surface label after owner approval';
    await assert.rejects(() => h.supervisor.admitPlan!({ ...h.batch(), proposal: mutated }), codeIs('plan-digest-mismatch'));
    await assert.rejects(() => h.authority.approvePlan!(mutated, h.approvalDocument, { runId: h.run.runId, now: NOW }), codeIs('plan-digest-mismatch'));
    assert.equal(h.store.listTasks(h.run.runId).length, 0);

    const wrongDigest = await h.ledger.approve({ run: h.run, proposalDigest: planProposalDigest(mutated), document: h.approvalDocument });
    assert.equal(wrongDigest.ok, false);
  } finally { h.store.close(); }
});

test('threat-model amendments are attributed, size-capped, rate-limited and visible to a second worker', async () => {
  const h = await createPlanHarness();
  try {
    const packet = planProposal(h.run, {
      proposalId: 'plan-threat-model',
      threatModel: {
        targetKey: 'fixtures/input.ts',
        body: 'Baseline: local fixture only. The handler reads fixtures/input.ts and must reject malformed input before the guard.',
      },
    });
    const proposed = h.ledger.propose({ packet, run: h.run, plannerAttemptId: 'planner-1' });
    assert.equal(proposed.ok, true);
    const store = h.ledger.threatModel(h.run.runId);
    assert.equal(store.read('fixtures/input.ts').found, true);

    const thin = store.amend({ targetKey: 'fixtures/input.ts', attemptId: 'attempt-a', text: 'too thin' });
    assert.equal(thin.ok ? '' : thin.code, 'threat-model-thin');
    const oversized = store.amend({ targetKey: 'fixtures/input.ts', attemptId: 'attempt-a', text: 'x'.repeat(4_096) });
    assert.equal(oversized.ok ? '' : oversized.code, 'threat-model-amendment-size');
    assert.equal(store.amend({ targetKey: 'fixtures/input.ts', attemptId: 'ghost', text: 'The guard only covers the first branch; fixtures/input.ts#second proves the second branch skips it.' }).ok, true);
    for (let index = 0; index < 3; index++) {
      const amended = store.amend({ targetKey: 'fixtures/input.ts', attemptId: 'attempt-a', text: `Amendment number ${index} names the guard path and the fixture file that proves it.` });
      assert.equal(amended.ok, true, JSON.stringify(amended));
    }
    const rateLimited = store.amend({ targetKey: 'fixtures/input.ts', attemptId: 'attempt-a', text: 'One more amendment beyond the per-attempt rate window for this attempt.' });
    assert.equal(rateLimited.ok ? '' : rateLimited.code, 'threat-model-rate-limit');

    const seen = store.read('fixtures/input.ts');
    assert.equal(seen.amendmentCount, 4);
    assert.equal(seen.amendments.at(-1)?.authorAttemptId, 'attempt-a');
    assert.ok(seen.amendments.every(amendment => amendment.authorAttemptId === 'attempt-a' || amendment.authorAttemptId === 'ghost'));
    const context = h.ledger.read(h.run.runId);
    assert.equal(context.threatModels.length, 1);
    assert.equal(context.threatModels[0]!.amendments.length, 4);

    const port = createWorkerContextPort({ ledger: h.ledger, runId: h.run.runId });
    const attemptB = { attemptId: 'attempt-b' } as unknown as AttemptRecord;
    const read = await port.read(attemptB, {}) as { found: boolean; models: Array<{ amendments: unknown[] }> };
    assert.equal(read.found, true);
    assert.equal(read.models[0]!.amendments.length, 4);
    const amended = await port.amend(attemptB, { targetKey: 'fixtures/input.ts', text: 'The second worker confirms fixtures/input.ts#handler is reachable with malformed input.' }, new AbortController().signal) as { ok: boolean };
    assert.equal(amended.ok, true, JSON.stringify(amended));
    assert.equal(store.read('fixtures/input.ts').amendmentCount, 5);

    const fresh = createPlanLedger({ controlRoot: h.controlRoot, authority: h.authority, clock: () => h.clock.now() });
    assert.equal(fresh.threatModel('run-fresh').read('fixtures/input.ts').found, false);
  } finally { h.store.close(); }
});

test('the coverage gate blocks a final report with an unresolved cell unless it is carried as untested', async () => {
  const h = await createPlanHarness();
  try {
    const approved = await h.ledger.approve({ run: h.run, proposalDigest: h.digest, document: h.approvalDocument });
    assert.equal(approved.ok, true);
    const open = h.ledger.coverage(h.run.runId);
    assert.equal(open.canFinalize, false);
    assert.deepEqual(open.unresolved, ['cell-1']);
    assert.equal(open.cells.length, 1);
    assert.equal(open.cells[0]!.outcome, 'open');
    assert.equal(open.cells[0]!.reportState, 'untested');
    assert.ok(open.issues.some(issue => issue.code === 'coverage-unresolved-cell'));

    const unknown = h.ledger.recordCoverageResolution({ runId: h.run.runId, cellId: 'cell-unknown', outcome: 'resolved', basis: 'runtime-observed', evidenceIds: ['ev-1'], reason: 'not planned anywhere', carried: false, authorAttemptId: 'worker-1', at: NOW });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.ok ? '' : unknown.code, 'coverage-unknown-cell');

    const noEvidence = h.ledger.recordCoverageResolution({ runId: h.run.runId, cellId: 'cell-1', outcome: 'resolved', basis: 'runtime-observed', evidenceIds: [], reason: 'resolved without a receipt', carried: false, authorAttemptId: 'worker-1', at: NOW });
    assert.equal(noEvidence.ok, false);
    assert.equal(noEvidence.ok ? '' : noEvidence.code, 'coverage-invalid');

    const carriedRecord = h.ledger.recordCoverageResolution({ runId: h.run.runId, cellId: 'cell-1', outcome: 'untested', basis: 'worker-asserted', evidenceIds: [], reason: 'The fixture branch needs credentials the run does not hold', carried: true, authorAttemptId: 'worker-1', at: NOW });
    assert.equal(carriedRecord.ok, true);
    const carried = h.ledger.coverage(h.run.runId);
    assert.equal(carried.canFinalize, true);
    assert.deepEqual(carried.carried, ['cell-1']);
    assert.equal(carried.cells[0]!.reportState, 'untested');
    assert.ok(carried.limitations.some(line => line.includes('cell-1')));

    const conflict = h.ledger.recordCoverageResolution({ runId: h.run.runId, cellId: 'cell-1', outcome: 'untested', basis: 'worker-asserted', evidenceIds: [], reason: 'A different conclusion for the same cell', carried: true, authorAttemptId: 'worker-2', at: NOW });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.ok ? '' : conflict.code, 'coverage-conflict');
  } finally { h.store.close(); }
});

test('needs_follow_up stays unresolved until it is explicitly carried as blocked', async () => {
  const h = await createPlanHarness();
  try {
    await h.ledger.approve({ run: h.run, proposalDigest: h.digest, document: h.approvalDocument });
    const recorded = h.ledger.recordCoverageResolution({ runId: h.run.runId, cellId: 'cell-1', outcome: 'needs_follow_up', basis: 'worker-asserted', evidenceIds: [], reason: 'Credentials for the second fixture branch are unavailable', carried: false, authorAttemptId: 'worker-1', at: NOW });
    assert.equal(recorded.ok, true);
    const gate = h.ledger.coverage(h.run.runId);
    assert.equal(gate.canFinalize, false);
    assert.deepEqual(gate.unresolved, ['cell-1']);
    assert.equal(gate.cells[0]!.outcome, 'needs_follow_up');

    const explicitCarry = reconcileCoverage(h.proposal.coverage, [{
      runId: h.run.runId, cellId: 'cell-1', outcome: 'blocked', basis: 'worker-asserted', evidenceIds: [],
      reason: 'Blocker confirmed; the cell is carried into the report as blocked', carried: true,
      authorAttemptId: 'worker-1', at: NOW,
    }], { runId: h.run.runId });
    assert.equal(explicitCarry.canFinalize, true);
    assert.deepEqual(explicitCarry.carried, ['cell-1']);
    assert.equal(explicitCarry.cells[0]!.reportState, 'blocked');

    const silentDrop = reconcileCoverage(h.proposal.coverage, [{
      runId: h.run.runId, cellId: 'cell-1', outcome: 'needs_follow_up', basis: 'worker-asserted', evidenceIds: [],
      reason: 'Still open and not carried', carried: false, authorAttemptId: 'worker-1', at: NOW,
    }], { runId: h.run.runId });
    assert.equal(silentDrop.canFinalize, false);
    assert.deepEqual(silentDrop.unresolved, ['cell-1']);
  } finally { h.store.close(); }
});

test('the plan port stores a worker packet and admits it once from an owner approval file', async () => {
  const h = await createPlanHarness({ grantPlanApproval: false });
  try {
    const directory = mkdtempSync(join(tmpdir(), 'p2o-planner-port-'));
    const proposalPath = join(directory, 'proposal.json');
    writeFileSync(proposalPath, `${JSON.stringify(planProposal(h.run, { proposalId: 'plan-port' }))}\n`, { mode: 0o600 });
    const proposingPort = createPlanPort({
      controlRoot: h.controlRoot, store: h.store, supervisor: h.supervisor, authority: h.authority,
      toolPolicy: TOOL_POLICY, boundaryReceipt: BOUNDARY, clock: () => h.clock.now(),
    });
    const proposed = await proposingPort.propose({ runId: h.run.runId, proposalPath }) as { ok: boolean; proposalId: string; proposalDigest: string };
    assert.equal(proposed.ok, true);
    const storedProposal = h.ledger.read(h.run.runId, proposed.proposalId).proposal!;
    const document = approvalDocument(storedProposal);
    assert.equal(document.proposalDigest, proposed.proposalDigest);

    const ownerAuthority = createOwnerAuthority({ version: 1, runs: [h.runAdmission], tasks: [], planApprovals: [document] });
    const ownerSupervisor = createSupervisor({
      store: h.store, authority: ownerAuthority, controlRoot: h.controlRoot, workspaceRoot: h.workspaceRoot,
      runtimes: {}, clock: h.clock, ownerId: 'supervisor-owner', reviewerId: 'reviewer-1', automatic: false,
      pollMs: 25, leaseMs: 120_000, startupTimeoutMs: 2_000, operationTimeoutMs: 2_000, stopReserveMs: 500,
    });
    const port = createPlanPort({
      controlRoot: h.controlRoot, store: h.store, supervisor: ownerSupervisor, authority: ownerAuthority,
      toolPolicy: TOOL_POLICY, boundaryReceipt: BOUNDARY, clock: () => h.clock.now(),
    });
    const approvalPath = join(directory, 'approval.json');
    writeFileSync(approvalPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    const approved = await port.approve({ runId: h.run.runId, proposalDigest: proposed.proposalDigest, approvalPath }) as { ok: boolean; admittedTaskIds: string[]; approval: { duplicate: boolean } };
    assert.equal(approved.ok, true);
    assert.deepEqual(approved.admittedTaskIds, ['task-1']);
    assert.equal(h.store.listTasks(h.run.runId).length, 1);

    const replay = await port.approve({ runId: h.run.runId, proposalDigest: proposed.proposalDigest, approvalPath }) as { ok: boolean; approval: { duplicate: boolean } };
    assert.equal(replay.ok, true);
    assert.equal(replay.approval.duplicate, true);
    assert.equal(h.store.listTasks(h.run.runId).length, 1);

    writeFileSync(approvalPath, `${JSON.stringify({ ...document, taskCount: 99 })}\n`, { mode: 0o600 });
    const altered = await port.approve({ runId: h.run.runId, proposalDigest: proposed.proposalDigest, approvalPath }) as { ok: boolean; code: string };
    assert.equal(altered.ok, false);
    assert.equal(altered.code, 'plan-approval-binding');

    writeFileSync(approvalPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    chmodSync(approvalPath, 0o666);
    await assert.rejects(() => port.approve({ runId: h.run.runId, proposalDigest: proposed.proposalDigest, approvalPath }), codeIs('plan-path'));
  } finally { h.store.close(); }
});
