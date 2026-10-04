import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  admitRunAndTasks, admitTaskEvidence, codeIs, createHarness, eventTypes, latestAttempt, modelSwitch,
  submitAccepted, subtaskRequest,
} from './fixtures.js';

const CONTINUING = { steps: [{ at: 0, status: 'running' as const }, { at: 30_000, status: 'settled' as const }] };
const MODEL_A = 'fixture-model-2';
const MODEL_B = 'fixture-model-3';

interface LaunchFile {
  replacedFrom?: string;
  switchId?: string;
  discoveredFrom?: string;
  request: { scopeDigest: string; inputDigest: string; deadlineAt: number; workspace: string; requested: { model: string } };
}

async function readLaunch(controlRoot: string, attemptId: string): Promise<LaunchFile> {
  return JSON.parse(await readFile(`${controlRoot}/launches/${attemptId}.json`, 'utf8')) as LaunchFile;
}

test('an approved switch of a discovered subtask keeps lineage, scope and input fingerprints', async () => {
  const harness = createHarness({ perTargetConcurrency: 2, runtimeOptions: CONTINUING });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const parentAttempt = latestAttempt(harness, 'task-1');
    const parent = harness.store.getTask('task-1')!;
    const discovery = await harness.supervisor.worker(parentAttempt.attemptId).requestSubtask(subtaskRequest(parent));
    assert.equal(discovery.admitted, true);
    await harness.supervisor.tick(harness.run.runId);
    const childAttempt = latestAttempt(harness, discovery.taskId!);
    assert.equal(harness.runtime.starts.length, 2);
    assert.equal(harness.store.getLease(discovery.taskId!)?.attemptId, childAttempt.attemptId);

    // A switch cannot bypass the replacement approval that is bound to the replaced attempt.
    harness.authority.denyReplacement = 'owner-declined-replacement';
    await assert.rejects(() => harness.supervisor.switchModel(childAttempt.attemptId, modelSwitch(MODEL_A)), codeIs('permission-denied'));
    assert.deepEqual(harness.runtime.checkpoints, []);
    assert.equal(harness.store.listAttempts(harness.run.runId).length, 2);
    assert.equal(harness.store.getLease(discovery.taskId!)?.attemptId, childAttempt.attemptId);
    const journaled = harness.supervisor.modelSwitches(harness.run.runId).at(-1)!;
    assert.equal(journaled.status, 'pending');
    assert.ok(journaled.approval);
    assert.ok(eventTypes(harness).includes('orchestrator.model-switch-failed'));

    // With both approvals the switch applies through the normal replacement path.
    harness.authority.denyReplacement = undefined;
    const applied = await harness.supervisor.switchModel(childAttempt.attemptId, modelSwitch(MODEL_A));
    assert.equal(applied.status, 'applied');
    assert.equal(applied.switchId, journaled.switchId);
    const replacement = harness.store.getAttempt(applied.replacement!.attemptId)!;
    assert.equal(replacement.taskId, discovery.taskId);

    const launch = await readLaunch(harness.controlRoot, replacement.attemptId);
    const parentLaunch = await readLaunch(harness.controlRoot, parentAttempt.attemptId);
    assert.equal(launch.replacedFrom, childAttempt.attemptId);
    assert.equal(launch.switchId, applied.switchId);
    assert.equal(launch.discoveredFrom, discovery.decisionId);
    assert.equal(harness.store.getTask(discovery.taskId!)?.parentTaskId, 'task-1');
    assert.equal(harness.store.getTask(discovery.taskId!)?.inputRevision, parent.inputRevision);
    assert.equal(launch.request.scopeDigest, parentLaunch.request.scopeDigest);
    assert.equal(launch.request.inputDigest, parentLaunch.request.inputDigest);
    assert.equal(launch.request.deadlineAt, parentLaunch.request.deadlineAt);
    assert.equal(launch.request.workspace, (await readLaunch(harness.controlRoot, childAttempt.attemptId)).request.workspace);
    assert.equal(launch.request.workspace, harness.supervisor.workspaceFor(discovery.taskId!));
    assert.equal(launch.request.requested.model, MODEL_A);

    // Exactly one live writer per task; the replaced writer is fenced and cannot be re-driven.
    const snapshot = harness.supervisor.snapshot(harness.run.runId);
    assert.equal(snapshot.outstandingLeases.length, 2);
    assert.equal(harness.store.getLease(discovery.taskId!)?.attemptId, replacement.attemptId);
    assert.equal(harness.store.getAttempt(childAttempt.attemptId)?.lifecycleState, 'exited');
    assert.equal(harness.runtime.checkpoints.filter(id => id === childAttempt.attemptId).length, 1);
    await assert.rejects(() => harness.supervisor.switchModel(childAttempt.attemptId, modelSwitch(MODEL_B)), codeIs('stale-attempt'));
    assert.equal(harness.store.listAttempts(harness.run.runId).length, 3);

    // The discovered subtask still ends in a first-class accepted packet after the switch.
    admitTaskEvidence(harness, discovery.taskId!);
    const accepted = await submitAccepted(harness, discovery.taskId!);
    assert.equal(accepted.decision.status, 'accepted');
    assert.equal(accepted.packet.attemptId, replacement.attemptId);
    assert.equal(accepted.packet.requestedRuntime.selection.model, MODEL_A);
  } finally { harness.store.close(); }
});

test('lineage is recorded from real causes and never fabricated for a plain task', async () => {
  const harness = createHarness({ perTargetConcurrency: 1, runtimeOptions: CONTINUING });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const first = latestAttempt(harness, 'task-1');
    const decision = await harness.supervisor.switchModel(first.attemptId, modelSwitch(MODEL_A));
    const launch = await readLaunch(harness.controlRoot, decision.replacement!.attemptId);
    assert.equal(launch.replacedFrom, first.attemptId);
    assert.equal(launch.switchId, decision.switchId);
    assert.equal(launch.discoveredFrom, undefined);
    assert.equal(harness.supervisor.subtaskDecisions(harness.run.runId).length, 0);
  } finally { harness.store.close(); }
});

test('a restored controller will not switch a discovered subtask without a fresh approval in session', async () => {
  const harness = createHarness({ perTargetConcurrency: 2, runtimeOptions: CONTINUING });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const parent = harness.store.getTask('task-1')!;
    const discovery = await harness.supervisor.worker(latestAttempt(harness, 'task-1').attemptId).requestSubtask(subtaskRequest(parent));
    await harness.supervisor.tick(harness.run.runId);
    const childAttempt = latestAttempt(harness, discovery.taskId!);

    const restart = createHarness({ root: harness.root, store: harness.store, clock: harness.clock, ownerId: 'supervisor-b', runtimeOptions: CONTINUING });
    try {
      await restart.supervisor.recover(harness.run.runId);
      await assert.rejects(() => restart.supervisor.switchModel(childAttempt.attemptId, modelSwitch(MODEL_A)), codeIs('task-not-admitted'));
      assert.equal(restart.runtime.checkpoints.length, 0);
      assert.equal(harness.store.listAttempts(harness.run.runId).length, 2);
      assert.equal(harness.store.getLease(discovery.taskId!)?.attemptId, childAttempt.attemptId);
      // The recorded discovery decision is still readable, so lineage is durable independently of authority.
      const [decision] = restart.supervisor.subtaskDecisions(harness.run.runId);
      assert.equal(decision.decisionId, discovery.decisionId);
      assert.equal(decision.taskId, discovery.taskId);
    } finally { restart.supervisor.dispose(); }
  } finally { harness.store.close(); }
});
