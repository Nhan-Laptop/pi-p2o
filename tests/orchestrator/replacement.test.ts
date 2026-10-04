import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { digestJson } from '../../src/contracts/index.js';
import {
  admitRunAndTasks, admitTaskEvidence, codeIs, createHarness, eventTypes, latestAttempt,
  submitAccepted, taskBudget,
} from './fixtures.js';

const replacement = { provider: 'fixture-provider', model: 'fixture-model-2', thinking: 'high' as const };

interface LaunchRequest {
  request: { scopeDigest: string; inputDigest: string; workspace: string; deadlineAt: number; requested: { provider: string; model: string; thinking: string } };
}
async function readLaunch(controlRoot: string, attemptId: string): Promise<LaunchRequest> {
  return JSON.parse(await readFile(`${controlRoot}/launches/${attemptId}.json`, 'utf8')) as LaunchRequest;
}

test('replacement requires owner approval before any stop or checkpoint', async () => {
  const harness = createHarness({ perTargetConcurrency: 1, runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    harness.authority.denyReplacement = 'owner-declined';
    await assert.rejects(() => harness.supervisor.replace(attempt.attemptId, replacement), codeIs('permission-denied'));
    assert.deepEqual(harness.runtime.checkpoints, []);
    assert.deepEqual(harness.runtime.stops, []);
    assert.equal(harness.store.getLease('task-1')?.attemptId, attempt.attemptId);
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.lifecycleState, 'running');
    assert.equal(harness.store.listAttempts(harness.run.runId).length, 1);
  } finally { harness.store.close(); }
});

test('replacement approval is bound to the replaced attempt', async () => {
  const harness = createHarness({ perTargetConcurrency: 1, runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    harness.authority.approveReplacement = async (proposal, run) => ({
      allowed: true, digest: digestJson(proposal),
      authorizationRef: run.authorization.reference, approvedBy: run.authorization.authorizedBy,
      reference: 'wrong-parent-approval', expiresAt: run.authorization.expiresAt, parentAttemptId: 'attempt-other',
    });
    await assert.rejects(() => harness.supervisor.replace(attempt.attemptId, replacement), codeIs('permission-denied'));
    assert.deepEqual(harness.runtime.checkpoints, []);
  } finally { harness.store.close(); }
});

test('a runtime without checkpoint capability cannot be replaced', async () => {
  const harness = createHarness({
    perTargetConcurrency: 1,
    runtimeOptions: { steps: [{ at: 0, status: 'running' }], capabilities: { checkpoints: false } },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    await assert.rejects(() => harness.supervisor.replace(attempt.attemptId, replacement), codeIs('capability'));
    assert.deepEqual(harness.runtime.checkpoints, []);
    assert.deepEqual(harness.runtime.stops, []);
  } finally { harness.store.close(); }
});

test('resume replacement checkpoints the writer and continues the bounded question with the approved model', async () => {
  const harness = createHarness({
    perTargetConcurrency: 1,
    runtimeOptions: { steps: [{ at: 0, status: 'running' }, { at: 30_000, status: 'settled' }] },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const first = latestAttempt(harness, 'task-1');
    const originalDeadline = first.deadlineAt;

    const result = await harness.supervisor.replace(first.attemptId, replacement);
    assert.equal(result.previousAttemptId, first.attemptId);
    assert.equal(result.continuity, 'resume');
    assert.equal(result.taskId, 'task-1');
    assert.deepEqual(harness.runtime.checkpoints, [first.attemptId]);
    assert.deepEqual(harness.runtime.resumes, [result.attemptId]);
    assert.equal(harness.store.listAttempts(harness.run.runId).length, 2);

    const previous = harness.store.getAttempt(first.attemptId);
    assert.equal(previous?.lifecycleState, 'exited');
    assert.equal(previous?.checkpoint?.id, result.checkpointId);
    assert.equal(previous?.checkpoint?.revision, first.attemptId);

    const current = harness.store.getAttempt(result.attemptId!);
    assert.equal(current?.requestedRuntime.selection.model, replacement.model);
    assert.equal(current?.requestedRuntime.selection.thinking, replacement.thinking);
    assert.equal(current?.deadlineAt, originalDeadline);
    assert.equal(harness.store.getLease('task-1')?.attemptId, result.attemptId);

    admitTaskEvidence(harness, 'task-1');
    const accepted = await submitAccepted(harness, 'task-1');
    assert.equal(accepted.decision.status, 'accepted');
    assert.equal(accepted.packet.attemptId, result.attemptId);
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.store.getRun(harness.run.runId)?.state, 'completed');
    assert.ok(eventTypes(harness).includes('orchestrator.attempt-replaced'));
  } finally { harness.store.close(); }
});

test('successor replacement keeps lineage when the runtime cannot resume a conversation', async () => {
  const harness = createHarness({
    perTargetConcurrency: 1,
    runtimeOptions: { steps: [{ at: 0, status: 'running' }, { at: 30_000, status: 'settled' }], capabilities: { canResume: false } },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1', { budgets: taskBudget({ maxAttempts: 2 }) })]);
    await harness.supervisor.tick(harness.run.runId);
    const first = latestAttempt(harness, 'task-1');
    await assert.rejects(() => harness.supervisor.replace(first.attemptId, replacement), codeIs('capability'));

    const result = await harness.supervisor.replace(first.attemptId, replacement, { continuity: 'successor' });
    assert.equal(result.continuity, 'successor');
    assert.equal(result.successorTaskId, 'task-1.sup1');
    assert.deepEqual(harness.runtime.resumes, []);
    const successor = harness.store.getTask('task-1.sup1');
    assert.equal(successor?.parentTaskId, 'task-1');
    assert.equal(successor?.depth, 1);
    assert.equal(successor?.requestedRuntime.selection.model, replacement.model);
    assert.equal(successor?.budgets.deadlineAt, first.deadlineAt);
    assert.ok(result.attemptId !== undefined);
    assert.equal(harness.store.getLease('task-1.sup1')?.attemptId, result.attemptId);
    assert.equal(harness.store.getAttempt(first.attemptId)?.lifecycleState, 'exited');
    assert.ok(eventTypes(harness).includes('orchestrator.task-superseded'));

    admitTaskEvidence(harness, 'task-1.sup1');
    const accepted = await submitAccepted(harness, 'task-1.sup1');
    assert.equal(accepted.decision.status, 'accepted');
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.store.getRun(harness.run.runId)?.state, 'completed');
    assert.equal(harness.store.listResults(harness.run.runId).filter(row => row.decision.status === 'accepted').length, 1);
  } finally { harness.store.close(); }
});

test('replacement is refused when no execution budget remains outside the reporting reserve', async () => {
  const harness = createHarness({ perTargetConcurrency: 1, runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    harness.clock.advance(Date.parse('2026-10-02T10:59:59.500Z') - harness.clock.now());
    await assert.rejects(() => harness.supervisor.replace(attempt.attemptId, replacement), codeIs('deadline'));
    assert.deepEqual(harness.runtime.checkpoints, []);
    assert.equal(harness.store.getLease('task-1')?.attemptId, attempt.attemptId);
  } finally { harness.store.close(); }
});

test('replacement preserves scope and input fingerprints for the new attempt', async () => {
  const harness = createHarness({ perTargetConcurrency: 1, runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const first = latestAttempt(harness, 'task-1');
    const result = await harness.supervisor.replace(first.attemptId, replacement);
    const before = await readLaunch(harness.controlRoot, first.attemptId);
    const after = await readLaunch(harness.controlRoot, result.attemptId!);
    assert.equal(after.request.scopeDigest, before.request.scopeDigest);
    assert.equal(after.request.inputDigest, before.request.inputDigest);
    assert.equal(after.request.workspace, before.request.workspace);
    assert.equal(after.request.deadlineAt, before.request.deadlineAt);
    assert.equal(before.request.requested.model, first.requestedRuntime.selection.model);
    assert.equal(after.request.requested.model, replacement.model);
    assert.equal(after.request.requested.thinking, replacement.thinking);
  } finally { harness.store.close(); }
});
