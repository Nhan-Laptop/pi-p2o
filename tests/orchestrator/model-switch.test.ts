import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { TaskManifest } from '../../src/contracts/index.js';
import {
  admitRunAndTasks, admitTaskEvidence, codeIs, createHarness, eventTypes, fixtureRun, latestAttempt,
  modelSwitch, submitAccepted,
} from './fixtures.js';

const RUNNING = { steps: [{ at: 0, status: 'running' as const }] };
const CONTINUING = { steps: [{ at: 0, status: 'running' as const }, { at: 30_000, status: 'settled' as const }] };
const MODEL_A = 'fixture-model-2';
const MODEL_B = 'fixture-model-3';
const FIXTURE_SELECTION = { provider: 'fixture-provider', model: 'fixture-model', thinking: 'high' as const };

interface LaunchFile {
  replacedFrom?: string;
  switchId?: string;
  request: { scopeDigest: string; inputDigest: string; deadlineAt: number; requested: { provider: string; model: string; thinking: string } };
}

async function readLaunch(controlRoot: string, attemptId: string): Promise<LaunchFile> {
  return JSON.parse(await readFile(`${controlRoot}/launches/${attemptId}.json`, 'utf8')) as LaunchFile;
}

test('a model switch without owner approval or authority support is refused and nothing changes', async () => {
  const harness = createHarness({ perTargetConcurrency: 1, runtimeOptions: RUNNING });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');

    harness.authority.denyModelSwitch = 'owner-declined-switch';
    await assert.rejects(() => harness.supervisor.switchModel(attempt.attemptId, modelSwitch(MODEL_A)), codeIs('permission-denied'));

    assert.deepEqual(harness.runtime.checkpoints, []);
    assert.deepEqual(harness.runtime.stops, []);
    assert.equal(harness.store.listAttempts(harness.run.runId).length, 1);
    assert.equal(harness.store.getLease('task-1')?.attemptId, attempt.attemptId);
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.lifecycleState, 'running');
    const [refused] = harness.supervisor.modelSwitches(harness.run.runId);
    assert.equal(refused.status, 'rejected');
    assert.equal(refused.code, 'permission-denied');
    assert.equal(refused.from.model, attempt.requestedRuntime.selection.model);
    assert.equal(refused.to.model, MODEL_A);
    assert.ok(eventTypes(harness).includes('orchestrator.model-switch-rejected'));

    // An authority that cannot approve a switch fails closed rather than applying it.
    harness.authority.approveModelSwitch = undefined;
    await assert.rejects(() => harness.supervisor.switchModel(attempt.attemptId, modelSwitch(MODEL_B)), codeIs('authority-unsupported'));
    assert.equal(harness.store.listAttempts(harness.run.runId).length, 1);
    assert.deepEqual(harness.runtime.checkpoints, []);
  } finally { harness.store.close(); }
});

test('a model switch outside the run provider/thinking profile is refused before any owner approval', async () => {
  const harness = createHarness({
    perTargetConcurrency: 1,
    runOverrides: { requestedRuntime: { adapter: 'headless', selection: { ...FIXTURE_SELECTION }, requiredCapabilities: ['ownsLifecycle'] } },
    runtimeOptions: RUNNING,
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');

    const profile = harness.supervisor.modelProfile(harness.run.runId);
    assert.deepEqual(profile.providers, ['fixture-provider']);
    assert.deepEqual(profile.models, ['fixture-model']);
    assert.equal(profile.thinkingCeiling, 'high');
    assert.equal(profile.adapter, 'headless');

    // Provider identity and the thinking ceiling come from the run: neither can be widened by a worker.
    await assert.rejects(
      () => harness.supervisor.switchModel(attempt.attemptId, { selection: { provider: 'other-provider', model: MODEL_A, thinking: 'high' }, reason: 'unauthorized provider' }),
      codeIs('capability-profile'),
    );
    await assert.rejects(
      () => harness.supervisor.switchModel(attempt.attemptId, { selection: { provider: 'fixture-provider', model: MODEL_A, thinking: 'max' }, reason: 'unauthorized effort' }),
      codeIs('capability-profile'),
    );
    await assert.rejects(() => harness.supervisor.switchModel(attempt.attemptId, modelSwitch('fixture-model', 'high')), codeIs('no-op'));
    assert.equal(harness.authority.calls.includes('approveModelSwitch'), false);
    assert.equal(harness.store.listAttempts(harness.run.runId).length, 1);
    assert.deepEqual(harness.runtime.checkpoints, []);
    assert.equal(harness.supervisor.modelSwitches(harness.run.runId).every(row => row.status === 'rejected'), true);
  } finally { harness.store.close(); }
});

test('a model switch exceeding the remaining attempt, time or run budget is refused', async () => {
  const attemptsHarness = createHarness({ perTargetConcurrency: 1, runtimeOptions: RUNNING });
  try {
    await admitRunAndTasks(attemptsHarness, [attemptsHarness.task('task-1', { budgets: { ...attemptsHarness.task('task-1').budgets, maxAttempts: 1 } })]);
    await attemptsHarness.supervisor.tick(attemptsHarness.run.runId);
    const attempt = latestAttempt(attemptsHarness, 'task-1');
    await assert.rejects(() => attemptsHarness.supervisor.switchModel(attempt.attemptId, modelSwitch(MODEL_A)), codeIs('task-budget'));
    assert.equal(attemptsHarness.supervisor.modelSwitches(attemptsHarness.run.runId)[0].code, 'task-budget');
    assert.deepEqual(attemptsHarness.runtime.checkpoints, []);
  } finally { attemptsHarness.store.close(); }

  const deadlineHarness = createHarness({ perTargetConcurrency: 1, runtimeOptions: RUNNING });
  try {
    await admitRunAndTasks(deadlineHarness, [deadlineHarness.task('task-1')]);
    await deadlineHarness.supervisor.tick(deadlineHarness.run.runId);
    const attempt = latestAttempt(deadlineHarness, 'task-1');
    deadlineHarness.clock.advance(Date.parse('2026-10-02T10:59:59.500Z') - deadlineHarness.clock.now());
    await assert.rejects(() => deadlineHarness.supervisor.switchModel(attempt.attemptId, modelSwitch(MODEL_A)), codeIs('deadline'));
    assert.equal(deadlineHarness.store.getLease('task-1')?.attemptId, attempt.attemptId);
    assert.deepEqual(deadlineHarness.runtime.checkpoints, []);
  } finally { deadlineHarness.store.close(); }

  const budget = { ...fixtureRun().budgets, maxRequests: 5, targetRequestLimits: { fixture: 5 } };
  const budgetHarness = createHarness({ perTargetConcurrency: 1, runOverrides: { budgets: budget }, runtimeOptions: RUNNING });
  try {
    await admitRunAndTasks(budgetHarness, [budgetHarness.task('task-1')]);
    await budgetHarness.supervisor.tick(budgetHarness.run.runId);
    const attempt = latestAttempt(budgetHarness, 'task-1');
    budgetHarness.supervisor.consumeBudget(attempt.attemptId, { requests: 5, targetId: 'fixture' });
    await assert.rejects(() => budgetHarness.supervisor.switchModel(attempt.attemptId, modelSwitch(MODEL_A)), codeIs('run-budget'));
    assert.equal(budgetHarness.store.listAttempts(budgetHarness.run.runId).length, 1);
    assert.deepEqual(budgetHarness.runtime.checkpoints, []);
  } finally { budgetHarness.store.close(); }
});

test('an approved switch replaces the live writer once, preserves fingerprints and replays idempotently', async () => {
  const harness = createHarness({ perTargetConcurrency: 1, runtimeOptions: CONTINUING });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const first = latestAttempt(harness, 'task-1');
    const decision = await harness.supervisor.switchModel(first.attemptId, modelSwitch(MODEL_A));

    assert.equal(decision.status, 'applied');
    assert.equal(decision.approvedBy, 'fixture-owner');
    assert.ok(decision.approval);
    assert.equal(decision.generation, 1);
    assert.equal(decision.replacement?.previousAttemptId, first.attemptId);
    assert.ok(decision.replacement?.checkpointId);
    const current = harness.store.getAttempt(decision.replacement!.attemptId)!;
    assert.equal(current.taskId, 'task-1');
    assert.equal(current.requestedRuntime.selection.model, MODEL_A);
    assert.deepEqual(harness.runtime.checkpoints, [first.attemptId]);
    assert.equal(harness.store.getAttempt(first.attemptId)?.lifecycleState, 'exited');
    assert.equal(harness.store.getLease('task-1')?.attemptId, current.attemptId);

    // Scope, input, workspace and deadline identity are preserved across the switch.
    const before = await readLaunch(harness.controlRoot, first.attemptId);
    const after = await readLaunch(harness.controlRoot, current.attemptId);
    assert.equal(after.request.scopeDigest, before.request.scopeDigest);
    assert.equal(after.request.inputDigest, before.request.inputDigest);
    assert.equal(after.request.deadlineAt, before.request.deadlineAt);
    assert.equal(after.replacedFrom, first.attemptId);
    assert.equal(after.switchId, decision.switchId);
    assert.equal(after.request.requested.model, MODEL_A);
    assert.equal(before.request.requested.model, 'fixture-model');

    // Idempotent replay: the same request returns the recorded decision and applies nothing again.
    const replay = await harness.supervisor.switchModel(first.attemptId, modelSwitch(MODEL_A));
    assert.deepEqual(replay, decision);
    assert.equal(harness.store.listAttempts(harness.run.runId).length, 2);
    assert.deepEqual(harness.runtime.checkpoints, [first.attemptId]);
    assert.equal(harness.supervisor.modelSwitches(harness.run.runId).length, 1);
    assert.equal(harness.supervisor.modelProfile(harness.run.runId).models.includes(MODEL_A), true);

    // A superseded attempt refuses any further switch, including a different selection.
    await assert.rejects(() => harness.supervisor.switchModel(first.attemptId, modelSwitch(MODEL_B)), codeIs('stale-attempt'));
    assert.equal(harness.store.listAttempts(harness.run.runId).length, 2);
    assert.deepEqual(harness.runtime.checkpoints, [first.attemptId]);

    // The switched writer continues the same bounded question to an accepted packet.
    admitTaskEvidence(harness, 'task-1');
    const accepted = await submitAccepted(harness, 'task-1');
    assert.equal(accepted.decision.status, 'accepted');
    assert.equal(accepted.packet.attemptId, current.attemptId);
    assert.equal(accepted.packet.requestedRuntime.selection.model, MODEL_A);
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.store.getRun(harness.run.runId)?.state, 'completed');
  } finally { harness.store.close(); }
});

test('a restart replays an applied switch and a lost ledger write cannot double-apply it', async () => {
  const harness = createHarness({ perTargetConcurrency: 1, runtimeOptions: CONTINUING });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const first = latestAttempt(harness, 'task-1');
    const decision = await harness.supervisor.switchModel(first.attemptId, modelSwitch(MODEL_A));
    const current = harness.store.getAttempt(decision.replacement!.attemptId)!;

    const second = createHarness({ root: harness.root, store: harness.store, clock: harness.clock, ownerId: 'supervisor-b', runtimeOptions: CONTINUING });
    try {
      await second.supervisor.recover(harness.run.runId);
      const replayed = await second.supervisor.switchModel(first.attemptId, modelSwitch(MODEL_A));
      assert.deepEqual(replayed, decision);
      assert.equal(second.runtime.checkpoints.length, 0);
      assert.equal(harness.store.listAttempts(harness.run.runId).length, 2);
      assert.equal(eventTypes(harness).filter(type => type === 'orchestrator.model-switch-applied').length, 1);
    } finally { second.supervisor.dispose(); }

    // Emulate a crash after the effect but before the applied ledger write.
    const journalPath = `${harness.controlRoot}/switches/${harness.run.runId}.json`;
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { version: number; entries: Record<string, unknown> };
    journal.entries[decision.switchId] = { ...decision, status: 'pending', replacement: undefined };
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`);

    const third = createHarness({ root: harness.root, store: harness.store, clock: harness.clock, ownerId: 'supervisor-c', runtimeOptions: CONTINUING });
    try {
      await third.supervisor.recover(harness.run.runId);
      const recovered = await third.supervisor.switchModel(first.attemptId, modelSwitch(MODEL_A));
      assert.equal(recovered.status, 'applied');
      assert.equal(recovered.switchId, decision.switchId);
      assert.equal(recovered.replacement?.attemptId, current.attemptId);
      assert.equal(third.runtime.checkpoints.length, 0);
      assert.equal(harness.store.listAttempts(harness.run.runId).length, 2);
      assert.equal(eventTypes(harness).filter(type => type === 'orchestrator.model-switch-applied').length, 1);
    } finally { third.supervisor.dispose(); }
  } finally { harness.store.close(); }
});

test('a switch journaled before its effect is refused after restart instead of silently applying', async () => {
  const harness = createHarness({ perTargetConcurrency: 1, runtimeOptions: RUNNING });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    harness.authority.denyModelSwitch = 'owner-declined-switch';
    await assert.rejects(() => harness.supervisor.switchModel(attempt.attemptId, modelSwitch(MODEL_A)), codeIs('permission-denied'));
    const [refused] = harness.supervisor.modelSwitches(harness.run.runId);

    // Emulate a crash after journaling the intent but before the owner approval and effect.
    const journalPath = `${harness.controlRoot}/switches/${harness.run.runId}.json`;
    await writeFile(journalPath, `${JSON.stringify({ version: 1, entries: { [refused.switchId]: { ...refused, status: 'pending', code: undefined } } })}\n`);

    const restart = createHarness({ root: harness.root, store: harness.store, clock: harness.clock, ownerId: 'supervisor-b', runtimeOptions: RUNNING });
    try {
      await restart.supervisor.recover(harness.run.runId);
      await assert.rejects(() => restart.supervisor.switchModel(attempt.attemptId, modelSwitch(MODEL_A)), codeIs('task-not-admitted'));
      assert.equal(harness.store.listAttempts(harness.run.runId).length, 1);
      assert.equal(restart.runtime.checkpoints.length, 0);
      assert.deepEqual(restart.runtime.stops, []);
      const settled = restart.supervisor.modelSwitches(harness.run.runId)[0];
      assert.equal(settled.status, 'rejected');
      assert.equal(settled.code, 'task-not-admitted');
    } finally { restart.supervisor.dispose(); }
  } finally { harness.store.close(); }
});

test('a runtime that cannot checkpoint and resume refuses a switch instead of starting a fresh writer', async () => {
  const harness = createHarness({ perTargetConcurrency: 1, runtimeOptions: { ...RUNNING, capabilities: { canResume: false } } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    await assert.rejects(() => harness.supervisor.switchModel(attempt.attemptId, modelSwitch(MODEL_A)), codeIs('capability'));
    assert.equal(harness.store.listAttempts(harness.run.runId).length, 1);
    assert.deepEqual(harness.runtime.checkpoints, []);
    assert.equal(harness.supervisor.modelSwitches(harness.run.runId)[0].code, 'capability');
  } finally { harness.store.close(); }
});

test('a plan-mode run never applies a model switch', async () => {
  const harness = createHarness();
  try {
    const task: TaskManifest = harness.task('task-1');
    await harness.supervisor.admitRun({ manifest: harness.run, mode: 'plan', perTargetConcurrency: { fixture: 1 } });
    await harness.supervisor.admitTask({ manifest: task, role: 'worker' });
    await assert.rejects(() => harness.supervisor.switchModel('attempt-missing', modelSwitch(MODEL_A)), codeIs('attempt-not-found'));
    assert.equal(harness.runtime.starts.length, 0);
  } finally { harness.store.close(); }
});
