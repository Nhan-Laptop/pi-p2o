import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ID_PATTERN } from '../../src/contracts/index.js';
import {
  admitRunAndTasks, codeIs, createHarness, eventTypes, fixtureRun, latestAttempt, subtaskRequest,
} from './fixtures.js';

const RUNNING = { steps: [{ at: 0, status: 'running' as const }] };

test('a discovered subtask is admitted with parent linkage, inherited limits and a durable decision', async () => {
  const harness = createHarness({ perTargetConcurrency: 2, runtimeOptions: RUNNING });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const parent = harness.store.getTask('task-1')!;
    const attempt = latestAttempt(harness, 'task-1');
    const decision = await harness.supervisor.worker(attempt.attemptId).requestSubtask(subtaskRequest(parent));

    assert.equal(decision.admitted, true);
    assert.equal(decision.parentTaskId, 'task-1');
    assert.equal(decision.parentAttemptId, attempt.attemptId);
    assert.equal(decision.code, undefined);
    assert.match(decision.decisionId, ID_PATTERN);
    assert.match(decision.taskId!, ID_PATTERN);

    // The child inherits, and can only narrow, the parent's scope/capability/action/budget limits.
    const child = harness.store.getTask(decision.taskId!)!;
    assert.equal(child.parentTaskId, 'task-1');
    assert.equal(child.depth, 1);
    assert.equal(child.inputRevision, parent.inputRevision);
    assert.deepEqual(child.scope.targetIds, parent.scope.targetIds);
    assert.deepEqual(child.scope.actor, parent.scope.actor);
    assert.deepEqual(child.scope.inputs, parent.scope.inputs);
    assert.deepEqual(child.requiredCapabilities, parent.requiredCapabilities);
    assert.deepEqual(child.allowedActions, parent.allowedActions);
    assert.deepEqual(child.skills, parent.skills);
    assert.deepEqual(child.dependencyTaskIds, parent.dependencyTaskIds);
    assert.deepEqual(child.budgets, parent.budgets);
    assert.equal(child.workspace, harness.supervisor.workspaceFor(child.taskId));
    assert.equal(child.lifecycleState, 'queued');

    // Explicit, durable decision record plus a durable event; the ledger survives a fresh controller read.
    assert.deepEqual(harness.supervisor.subtaskDecisions(harness.run.runId).map(row => row.decisionId), [decision.decisionId]);
    assert.ok(eventTypes(harness).includes('orchestrator.subtask-admitted'));
    assert.equal(harness.authority.calls.filter(call => call === 'approveTask').length, 2);

    // The admitted child is scheduled and its launch record carries the discovery lineage.
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.runtime.starts.length, 2);
    const childAttempt = latestAttempt(harness, child.taskId);
    const launch = JSON.parse(await readFile(`${harness.controlRoot}/launches/${childAttempt.attemptId}.json`, 'utf8')) as { discoveredFrom?: string; request: { scopeDigest: string; inputDigest: string } };
    assert.equal(launch.discoveredFrom, decision.decisionId);
    const parentLaunch = JSON.parse(await readFile(`${harness.controlRoot}/launches/${attempt.attemptId}.json`, 'utf8')) as { request: { scopeDigest: string; inputDigest: string } };
    assert.equal(launch.request.scopeDigest, parentLaunch.request.scopeDigest);
    assert.equal(launch.request.inputDigest, parentLaunch.request.inputDigest);
  } finally { harness.store.close(); }
});

test('an over-cap discovered subtask is rejected with an explicit record and leaves no partial state', async () => {
  const budgets = { ...fixtureRun().budgets, maxTasks: 2, maxConcurrency: 2 };
  const harness = createHarness({ perTargetConcurrency: 2, runOverrides: { budgets }, runtimeOptions: RUNNING });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1'), harness.task('task-2')]);
    await harness.supervisor.tick(harness.run.runId);
    const tasksBefore = harness.store.listTasks(harness.run.runId).length;
    const attemptsBefore = harness.store.listAttempts(harness.run.runId).length;
    const parent = harness.store.getTask('task-1')!;

    await assert.rejects(
      () => harness.supervisor.worker(latestAttempt(harness, 'task-1').attemptId).requestSubtask(subtaskRequest(parent)),
      codeIs('task-limit'),
    );

    // Explicit rejection is recorded, and nothing partial was created.
    const decisions = harness.supervisor.subtaskDecisions(harness.run.runId);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].admitted, false);
    assert.equal(decisions[0].code, 'task-limit');
    assert.equal(decisions[0].taskId, undefined);
    assert.ok(eventTypes(harness).includes('orchestrator.subtask-rejected'));
    assert.equal(harness.store.listTasks(harness.run.runId).length, tasksBefore);
    assert.equal(harness.store.listAttempts(harness.run.runId).length, attemptsBefore);
    assert.equal(harness.store.listResults(harness.run.runId).length, 0);
    assert.deepEqual(harness.supervisor.snapshot(harness.run.runId).outstandingLeases.sort(), ['task-1', 'task-2']);
  } finally { harness.store.close(); }
});

test('a discovered subtask beyond the approved depth is rejected as a depth breach', async () => {
  const budgets = { ...fixtureRun().budgets, maxDepth: 0 };
  const harness = createHarness({ perTargetConcurrency: 2, runOverrides: { budgets }, runtimeOptions: RUNNING });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const parent = harness.store.getTask('task-1')!;
    await assert.rejects(
      () => harness.supervisor.worker(latestAttempt(harness, 'task-1').attemptId).requestSubtask(subtaskRequest(parent)),
      codeIs('task-depth'),
    );
    assert.equal(harness.store.listTasks(harness.run.runId).length, 1);
    assert.equal(harness.supervisor.subtaskDecisions(harness.run.runId)[0].code, 'task-depth');
  } finally { harness.store.close(); }
});

test('a discovered subtask cannot widen targets, actor, actions, capabilities, inputs or budget', async () => {
  const harness = createHarness({ perTargetConcurrency: 2, runtimeOptions: RUNNING });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const parent = harness.store.getTask('task-1')!;
    const port = harness.supervisor.worker(latestAttempt(harness, 'task-1').attemptId);

    // An unapproved target is refused by the contract gate before it can be narrowed.
    await assert.rejects(() => port.requestSubtask(subtaskRequest(parent, { targetIds: ['unapproved-target'] })), codeIs('scope-rejected'));
    // Approved-but-wider than the parent, a foreign actor, extra actions/capabilities and a larger budget are all widening.
    await assert.rejects(
      () => port.requestSubtask(subtaskRequest(parent, { allowedActions: ['review', 'mutate'] })),
      codeIs('scope-widening'),
    );
    await assert.rejects(() => port.requestSubtask(subtaskRequest(parent, { skills: ['dynamic-exploitation'] })), codeIs('scope-widening'));
    await assert.rejects(
      () => port.requestSubtask(subtaskRequest(parent, { actor: { id: 'other-actor', privileges: ['read-only'] } })),
      codeIs('scope-widening'),
    );
    await assert.rejects(
      () => port.requestSubtask(subtaskRequest(parent, { budgets: { maxRequests: parent.budgets.maxRequests + 1 } })),
      codeIs('scope-widening'),
    );
    await assert.rejects(() => port.requestSubtask(subtaskRequest(parent, { inputRevision: 'r2' })), codeIs('scope-widening'));
    assert.equal(harness.store.listTasks(harness.run.runId).length, 1);
    assert.ok(harness.supervisor.subtaskDecisions(harness.run.runId).every(decision => decision.admitted === false));
  } finally { harness.store.close(); }
});

test('per-target concurrency refuses a discovered subtask while the target is saturated', async () => {
  const harness = createHarness({ perTargetConcurrency: 1, runtimeOptions: RUNNING });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const parent = harness.store.getTask('task-1')!;
    await assert.rejects(
      () => harness.supervisor.worker(latestAttempt(harness, 'task-1').attemptId).requestSubtask(subtaskRequest(parent)),
      codeIs('target-concurrency'),
    );
    assert.equal(harness.store.listTasks(harness.run.runId).length, 1);
    assert.match(harness.supervisor.subtaskDecisions(harness.run.runId)[0].reasons[0]!, /live writer\(s\) at limit 1/);
  } finally { harness.store.close(); }
});

test('an owner-denied discovery is explicit, recorded and creates no task', async () => {
  const harness = createHarness({ perTargetConcurrency: 2, runtimeOptions: RUNNING });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const parent = harness.store.getTask('task-1')!;
    harness.authority.denyTask = 'owner-declined-discovery';
    await assert.rejects(
      () => harness.supervisor.worker(latestAttempt(harness, 'task-1').attemptId).requestSubtask(subtaskRequest(parent)),
      codeIs('permission-denied'),
    );
    assert.equal(harness.store.listTasks(harness.run.runId).length, 1);
    assert.equal(harness.supervisor.subtaskDecisions(harness.run.runId)[0].code, 'permission-denied');
  } finally { harness.store.close(); }
});

test('replay and controller restart cannot double-admit a discovered subtask', async () => {
  const harness = createHarness({ perTargetConcurrency: 2, runtimeOptions: RUNNING });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const parent = harness.store.getTask('task-1')!;
    const attempt = latestAttempt(harness, 'task-1');
    const first = await harness.supervisor.worker(attempt.attemptId).requestSubtask(subtaskRequest(parent));
    const second = await harness.supervisor.worker(attempt.attemptId).requestSubtask(subtaskRequest(parent));
    assert.deepEqual(second, first);
    assert.equal(harness.store.listTasks(harness.run.runId).length, 2);
    assert.equal(eventTypes(harness).filter(type => type === 'orchestrator.subtask-admitted').length, 1);

    const restart = createHarness({ root: harness.root, store: harness.store, clock: harness.clock, ownerId: 'supervisor-b', runtimeOptions: RUNNING });
    try {
      await restart.supervisor.recover(harness.run.runId);
      const replayed = await restart.supervisor.worker(attempt.attemptId).requestSubtask(subtaskRequest(parent));
      assert.deepEqual(replayed, first);
      assert.equal(restart.authority.calls.includes('approveTask'), false);
      assert.equal(harness.store.listTasks(harness.run.runId).length, 2);
      assert.equal(eventTypes(harness).filter(type => type === 'orchestrator.subtask-admitted').length, 1);
      assert.equal(restart.supervisor.subtaskDecisions(harness.run.runId).length, 1);
    } finally { restart.supervisor.dispose(); }
  } finally { harness.store.close(); }
});

test('a rejected discovery can be retried once the deterministic gate clears, without leaving duplicates', async () => {
  const budgets = { ...fixtureRun().budgets, maxTasks: 2, maxConcurrency: 2 };
  const harness = createHarness({ perTargetConcurrency: 2, runOverrides: { budgets }, runtimeOptions: RUNNING });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1'), harness.task('task-2')]);
    await harness.supervisor.tick(harness.run.runId);
    const parent = harness.store.getTask('task-1')!;
    const port = harness.supervisor.worker(latestAttempt(harness, 'task-1').attemptId);
    await assert.rejects(() => port.requestSubtask(subtaskRequest(parent)), codeIs('task-limit'));
    assert.equal(harness.supervisor.subtaskDecisions(harness.run.runId)[0].admitted, false);

    // Retrying while the gate is unchanged stays refused and still creates nothing.
    await assert.rejects(() => port.requestSubtask(subtaskRequest(parent)), codeIs('task-limit'));
    assert.equal(harness.store.listTasks(harness.run.runId).length, 2);
    assert.equal(harness.supervisor.subtaskDecisions(harness.run.runId).length, 1);
  } finally { harness.store.close(); }
});

test('a restored controller completes a discovery whose decision write was lost without re-approving it twice', async () => {
  const harness = createHarness({ perTargetConcurrency: 2, runtimeOptions: RUNNING });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const parent = harness.store.getTask('task-1')!;
    const attempt = latestAttempt(harness, 'task-1');
    const admitted = await harness.supervisor.worker(attempt.attemptId).requestSubtask(subtaskRequest(parent));

    // Emulate the crash window: the deterministic child exists in the store while the ledger entry is gone.
    await writeFile(`${harness.controlRoot}/subtasks/${harness.run.runId}.json`, `${JSON.stringify({ version: 1, entries: {} })}\n`);

    const restart = createHarness({ root: harness.root, store: harness.store, clock: harness.clock, ownerId: 'supervisor-b', runtimeOptions: RUNNING });
    try {
      await restart.supervisor.recover(harness.run.runId);
      const replayed = await restart.supervisor.worker(attempt.attemptId).requestSubtask(subtaskRequest(parent));
      assert.equal(replayed.admitted, true);
      assert.equal(replayed.taskId, admitted.taskId);
      assert.equal(replayed.decisionId, admitted.decisionId);
      assert.equal(harness.store.listTasks(harness.run.runId).length, 2);
      // No second owner approval was requested for the already-admitted child.
      assert.equal(restart.authority.calls.includes('approveTask'), false);
      assert.equal(eventTypes(harness).filter(type => type === 'orchestrator.subtask-admitted').length, 1);
    } finally { restart.supervisor.dispose(); }
  } finally { harness.store.close(); }
});
