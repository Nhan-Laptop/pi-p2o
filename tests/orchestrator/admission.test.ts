import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness, admitRunAndTasks, codeIs, fixtureScope, taskBudget } from './fixtures.js';

test('run admission fails closed without a matching owner approval', async () => {
  const harness = createHarness();
  try {
    harness.authority.denyRun = 'not-approved';
    await assert.rejects(
      () => harness.supervisor.admitRun({ manifest: harness.run, mode: 'managed', perTargetConcurrency: { fixture: 1 } }),
      codeIs('permission-denied'),
    );
    assert.equal(harness.store.getRun(harness.run.runId), undefined);
    assert.equal(harness.store.listEvents().length, 0);

    harness.authority.denyRun = undefined;
    const run = await harness.supervisor.admitRun({ manifest: harness.run, mode: 'managed', perTargetConcurrency: { fixture: 2 } });
    assert.equal(run.state, 'active');
    const repeat = await harness.supervisor.admitRun({ manifest: harness.run, mode: 'managed', perTargetConcurrency: { fixture: 2 } });
    assert.equal(repeat.runId, run.runId);
  } finally { harness.store.close(); }
});

test('run approval must cover the whole execution budget', async () => {
  const harness = createHarness();
  try {
    harness.authority.approvalExpiresAt = '2026-10-02T10:30:00.000Z';
    await assert.rejects(
      () => harness.supervisor.admitRun({ manifest: harness.run, mode: 'managed', perTargetConcurrency: { fixture: 1 } }),
      codeIs('permission-expired'),
    );
    assert.equal(harness.store.getRun(harness.run.runId), undefined);
  } finally { harness.store.close(); }
});

test('managed task admission requires the derived private workspace, a role profile and serialization keys', async () => {
  const harness = createHarness();
  try {
    await harness.supervisor.admitRun({ manifest: harness.run, mode: 'managed', perTargetConcurrency: { fixture: 2 } });
    await assert.rejects(
      () => harness.supervisor.admitTask({ manifest: { ...harness.task('task-1'), workspace: '/tmp/not-derived' }, role: 'worker' }),
      codeIs('workspace'),
    );
    await assert.rejects(
      () => harness.supervisor.admitTask({ manifest: harness.task('task-1', { requiredCapabilities: ['source.analyze'] }), role: 'orchestrator' }),
      codeIs('role-escalation'),
    );
    await assert.rejects(
      () => harness.supervisor.admitTask({ manifest: harness.task('task-1', { allowedActions: ['review', 'mutate'] }), role: 'worker' }),
      codeIs('serialization-required'),
    );
    harness.authority.denyTask = 'owner-denied';
    await assert.rejects(() => harness.supervisor.admitTask({ manifest: harness.task('task-1'), role: 'worker' }), codeIs('permission-denied'));
    harness.authority.denyTask = undefined;
    const task = await harness.supervisor.admitTask({ manifest: harness.task('task-1'), role: 'worker' });
    assert.equal(task.lifecycleState, 'queued');
    assert.ok(harness.store.listEvents({ runId: harness.run.runId }).some(event => event.type === 'orchestrator.task-admitted'));
  } finally { harness.store.close(); }
});

test('unrestricted host execution tools are denied even for inert fixtures', async () => {
  const harness = createHarness();
  try {
    await harness.supervisor.admitRun({ manifest: harness.run, mode: 'managed', perTargetConcurrency: { fixture: 1 } });
    harness.authority.toolPolicy = { mode: 'trusted-fixture', allowUnsandboxedHostTools: true, tools: ['bash'] };
    await assert.rejects(() => harness.supervisor.admitTask({ manifest: harness.task('task-1'), role: 'worker' }), codeIs('host-tools-denied'));
    harness.authority.toolPolicy = { mode: 'sandbox-extension', boundaryId: 'lab', extension: { path: '/opt/p2o/broker.js', sha256: 'd'.repeat(64), approval: 'owner-pinned' }, tools: ['broker_http'] };
    const task = await harness.supervisor.admitTask({ manifest: harness.task('task-1'), role: 'worker' });
    assert.equal(task.taskId, 'task-1');
  } finally { harness.store.close(); }
});

test('scope, capability, depth and task-count limits are enforced at admission', async () => {
  const harness = createHarness();
  try {
    await harness.supervisor.admitRun({ manifest: harness.run, mode: 'managed', perTargetConcurrency: { fixture: 2 } });
    const outsideScope = harness.task('task-1', { scope: { ...fixtureScope(harness.run), targetIds: ['unapproved-target'] } });
    await assert.rejects(() => harness.supervisor.admitTask({ manifest: outsideScope, role: 'worker' }), codeIs('scope-rejected'));
    const escalated = harness.task('task-2', { requiredCapabilities: ['run.admin'] });
    await assert.rejects(() => harness.supervisor.admitTask({ manifest: escalated, role: 'worker' }), codeIs('scope-rejected'));
    const deep = harness.task('task-3', { depth: 4 });
    await assert.rejects(() => harness.supervisor.admitTask({ manifest: deep, role: 'worker' }), codeIs('scope-rejected'));
    const expired = harness.task('task-4', { budgets: taskBudget({ deadlineAt: '2026-10-02T11:30:00.000Z' }) });
    await assert.rejects(() => harness.supervisor.admitTask({ manifest: expired, role: 'worker' }), codeIs('scope-rejected'));
    assert.equal(harness.store.listTasks(harness.run.runId).length, 0);
    await harness.supervisor.admitTask({ manifest: harness.task('task-1'), role: 'worker' });
    await assert.rejects(
      () => harness.supervisor.admitTask({ manifest: harness.task('task-2', { budgets: taskBudget({ deadlineAt: '2026-10-02T11:30:00.000Z' }) }), role: 'worker' }),
      codeIs('scope-rejected'),
    );
  } finally { harness.store.close(); }
});

test('plan mode is preview-only: it never leases, launches or starts', async () => {
  const harness = createHarness();
  try {
    await harness.supervisor.admitRun({ manifest: harness.run, mode: 'plan', perTargetConcurrency: { fixture: 1 } });
    await harness.supervisor.admitTask({ manifest: harness.task('task-1'), role: 'worker' });
    assert.throws(() => harness.supervisor.start(harness.run.runId), codeIs('plan-mode'));
    const snapshot = await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.runtime.starts.length, 0);
    assert.equal(harness.runtime.maxConcurrent, 0);
    assert.equal(snapshot.outstandingLeases.length, 0);
    assert.equal(snapshot.attempts.length, 0);
    const preview = harness.supervisor.preview(harness.run.runId);
    assert.equal(preview.guarantees, 'unmanaged-no-execution');
    assert.equal(preview.tasks.length, 1);
    assert.equal(preview.tasks[0].taskId, 'task-1');
    const reconciliation = await harness.supervisor.recover(harness.run.runId);
    assert.deepEqual(reconciliation.retryableTaskIds, []);
  } finally { harness.store.close(); }
});

test('a runtime that does not own lifecycle is rejected before any worker start', async () => {
  const harness = createHarness({ runtimeOptions: { capabilities: { ownsLifecycle: false } } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1', { budgets: taskBudget({ maxAttempts: 1 }) })]);
    const snapshot = await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.runtime.starts.length, 0);
    assert.equal(snapshot.attempts[0].lifecycleState, 'failed');
    assert.equal(harness.store.listTasks(harness.run.runId)[0].lifecycleState, 'failed');
    assert.ok(harness.store.listEvents({ runId: harness.run.runId }).some(event => event.type === 'orchestrator.runtime-rejected'));
    assert.equal(snapshot.outstandingLeases.length, 0);
  } finally { harness.store.close(); }
});

test('worker-proposed tasks still require owner approval and cannot widen scope', async () => {
  const harness = createHarness();
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = harness.store.listAttempts(harness.run.runId, 'task-1')[0];
    const port = harness.supervisor.worker(attempt.attemptId);

    const foreign: unknown = { manifest: { ...harness.task('task-2'), parentTaskId: 'task-other', depth: 1 }, role: 'worker' };
    await assert.rejects(() => port.proposeChild(foreign as never), codeIs('parent-task'));
    await assert.rejects(
      () => port.proposeChild({ manifest: { ...harness.task('task-2'), parentTaskId: 'task-1', depth: 1, requiredCapabilities: ['native.inspect'] }, role: 'worker' }),
      codeIs('scope-rejected'),
    );
    await assert.rejects(
      () => port.proposeChild({ manifest: { ...harness.task('task-2'), parentTaskId: 'task-1', depth: 1 }, role: 'reporter' }),
      codeIs('role'),
    );
    harness.authority.denyTask = 'worker-request-denied';
    await assert.rejects(
      () => port.proposeChild({ manifest: { ...harness.task('task-2'), parentTaskId: 'task-1', depth: 1 }, role: 'worker' }),
      codeIs('permission-denied'),
    );
    harness.authority.denyTask = undefined;
    const child = await port.proposeChild({ manifest: { ...harness.task('task-2'), parentTaskId: 'task-1', depth: 1 }, role: 'worker' });
    assert.equal(child.parentTaskId, 'task-1');
    assert.equal(child.depth, 1);
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.runtime.starts.length, 2);
  } finally { harness.store.close(); }
});
