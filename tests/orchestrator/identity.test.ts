import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ID_PATTERN, type AttemptRecord } from '../../src/contracts/index.js';
import type { RuntimeHandle } from '../../src/runtime/types.js';
import {
  admitRunAndRoleTasks, admitRunAndTasks, admitTaskEvidence, codeIs, createHarness, latestAttempt,
  packetFor, submitPacket, submitAccepted,
} from './fixtures.js';

const CONTROLLER = 'supervisor-a';
const REPLACEMENT = { provider: 'fixture-provider', model: 'fixture-model-2', thinking: 'high' as const };

interface LaunchFile {
  attemptId: string; producerId: string; leaseToken: string; generation: number;
}

async function readLaunch(controlRoot: string, attemptId: string): Promise<LaunchFile> {
  return JSON.parse(await readFile(`${controlRoot}/launches/${attemptId}.json`, 'utf8')) as LaunchFile;
}

test('each attempt carries a unique per-attempt producer identity while the controller keeps ownership', async () => {
  const harness = createHarness({ perTargetConcurrency: 3, runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1'), harness.task('task-2')]);
    await harness.supervisor.tick(harness.run.runId);
    const first = latestAttempt(harness, 'task-1');
    const second = latestAttempt(harness, 'task-2');

    // Unique producing identities, distinct from the controller identity that owns the run, outbox and receipts.
    assert.notEqual(first.attemptId, second.attemptId);
    assert.notEqual(first.ownerId, second.ownerId);
    for (const attempt of [first, second]) {
      assert.notEqual(attempt.ownerId, CONTROLLER);
      assert.match(attempt.ownerId, ID_PATTERN);
      assert.equal(attempt.ownerId, `${CONTROLLER}.worker.${attempt.attemptId}`);
      assert.equal(harness.supervisor.worker(attempt.attemptId).identity.producerId, attempt.ownerId);
      const launch = await readLaunch(harness.controlRoot, attempt.attemptId);
      assert.equal(launch.producerId, attempt.ownerId);
      assert.equal(launch.attemptId, attempt.attemptId);
      assert.equal(launch.leaseToken, attempt.leaseToken);
      assert.equal(harness.store.getLease(attempt.taskId)?.ownerId, attempt.ownerId);
    }

    // Controller ownership is unchanged: runtime receipts and lifecycle events are authored by this.ownerId.
    const receipt = harness.store.listEvidence(harness.run.runId)
      .find(evidence => evidence.kind === 'runtime' && evidence.attemptId === first.attemptId);
    assert.ok(receipt, 'controller runtime receipt exists');
    assert.equal(receipt.provenance.collectorId, CONTROLLER);
    const events = harness.store.listEvents({ runId: harness.run.runId });
    assert.equal((events.find(event => event.type === 'orchestrator.run-started')?.payload as { ownerId?: string }).ownerId, CONTROLLER);
    const launched = events.find(event => event.type === 'orchestrator.attempt-launched' && event.attemptId === first.attemptId);
    assert.equal((launched?.payload as { producerId?: string }).producerId, first.ownerId);
    const claimed = harness.store.claimOutbox({ ownerId: CONTROLLER, limit: 64, leaseMs: 60_000 });
    assert.ok(claimed.length > 0);
    assert.ok(claimed.every(entry => entry.claimOwner === CONTROLLER));
    assert.ok(harness.store.listOutbox({ includeDelivered: false })
      .every(entry => entry.claimOwner !== first.ownerId && entry.claimOwner !== second.ownerId));

    // The handoff gate is not weakened: another attempt's producing identity is refused.
    admitTaskEvidence(harness, 'task-1');
    const crossed = await submitPacket(harness, 'task-1', packetFor(harness, 'task-1', {
      packetId: 'packet-crossed-1', producerId: second.ownerId,
    }));
    assert.equal(crossed.decision.status, 'returned-for-evidence');
    assert.ok(crossed.decision.reasons.some(reason => reason.code === 'attempt-identity'));
  } finally { harness.store.close(); }
});

test('a verifier attempt is a distinct production identity from the producer it replays', async () => {
  const harness = createHarness({ perTargetConcurrency: 3, runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    harness.run.authorization.allowedActions = [...harness.run.authorization.allowedActions, 'read'];
    const producer = harness.task('task-a');
    const verifier = harness.task('task-v', {
      requiredCapabilities: [], allowedActions: ['read'], skills: ['independent-replay'],
    });
    await admitRunAndRoleTasks(harness, [{ task: producer, role: 'worker' }, { task: verifier, role: 'verifier' }]);
    await harness.supervisor.tick(harness.run.runId);

    const produced = latestAttempt(harness, 'task-a');
    const verifying = latestAttempt(harness, 'task-v');
    assert.notEqual(verifying.attemptId, produced.attemptId);
    assert.notEqual(verifying.ownerId, produced.ownerId);
    assert.equal(verifying.ownerId, `${CONTROLLER}.verifier.${verifying.attemptId}`);

    admitTaskEvidence(harness, 'task-a');
    const findingPacket = await submitPacket(harness, 'task-a', packetFor(harness, 'task-a'));
    assert.equal(findingPacket.decision.status, 'accepted');
    assert.equal(findingPacket.packet.producer.id, produced.ownerId);

    // Exact `replayFinding` verifier-identity precondition (`src/evidence/replay.ts`) with real supervisor identities:
    // the verifier attempt can be its own authorized verifierId while remaining distinct from the producer identity
    // and from the producing attempt. No evidence gate is relaxed to make this hold.
    const verifierId = verifying.ownerId;
    const replayIdentity = (attempt: AttemptRecord, finding: { producerId: string }, producerAttemptId: string): boolean =>
      attempt.ownerId === verifierId && verifierId !== finding.producerId && attempt.attemptId !== producerAttemptId;
    assert.equal(replayIdentity(verifying, { producerId: findingPacket.packet.producer.id }, produced.attemptId), true);
    assert.equal(replayIdentity(produced, { producerId: findingPacket.packet.producer.id }, produced.attemptId), false);

    // The orchestrator identity gate still refuses a verifier packet that claims the producer's identity.
    admitTaskEvidence(harness, 'task-v');
    const forged = await submitPacket(harness, 'task-v', packetFor(harness, 'task-v', {
      packetId: 'packet-forged-verifier-1', producerId: produced.ownerId, allowedActions: ['read'],
    }));
    assert.equal(forged.decision.status, 'returned-for-evidence');
    assert.ok(forged.decision.reasons.some(reason => reason.code === 'attempt-identity'));

    const own = await submitPacket(harness, 'task-v', packetFor(harness, 'task-v', {
      packetId: 'packet-verifier-1', allowedActions: ['read'],
    }), 'verifier-key');
    assert.equal(own.decision.status, 'accepted');
    assert.equal(own.packet.producer.id, verifying.ownerId);
  } finally { harness.store.close(); }
});

test('producer identity is durable across controller restart and control transfer', async () => {
  const harness = createHarness({ perTargetConcurrency: 1, runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');

    const second = createHarness({ root: harness.root, store: harness.store, clock: harness.clock, ownerId: 'supervisor-b' });
    try {
      const report = await second.supervisor.recover(harness.run.runId);
      assert.deepEqual(report.resumed, [attempt.attemptId]);
      const recovered = harness.store.getAttempt(attempt.attemptId);
      assert.equal(recovered?.ownerId, attempt.ownerId);
      assert.equal(harness.store.getLease('task-1')?.ownerId, attempt.ownerId);
      assert.equal(second.supervisor.worker(attempt.attemptId).identity.producerId, attempt.ownerId);
      const control = JSON.parse(await readFile(`${harness.controlRoot}/control/${harness.run.runId}.json`, 'utf8')) as { ownerId: string };
      assert.equal(control.ownerId, 'supervisor-b');
      assert.notEqual(recovered?.ownerId, control.ownerId);
    } finally { second.supervisor.dispose(); }
  } finally { harness.store.close(); }
});

test('replacement resume keeps fencing while the new attempt gets its own producer identity', async () => {
  const harness = createHarness({
    perTargetConcurrency: 1,
    runtimeOptions: { steps: [{ at: 0, status: 'running' }, { at: 30_000, status: 'settled' }] },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const first = latestAttempt(harness, 'task-1');

    const result = await harness.supervisor.replace(first.attemptId, REPLACEMENT);
    const current = harness.store.getAttempt(result.attemptId!);
    assert.ok(current);
    assert.notEqual(current.attemptId, first.attemptId);
    assert.notEqual(current.ownerId, first.ownerId);
    assert.equal(current.ownerId, `${CONTROLLER}.worker.${current.attemptId}`);
    assert.equal(harness.store.getLease('task-1')?.ownerId, current.ownerId);
    assert.equal(harness.store.getLease('task-1')?.token, current.leaseToken);
    assert.notEqual(current.leaseToken, first.leaseToken);
    assert.equal((await readLaunch(harness.controlRoot, first.attemptId)).producerId, first.ownerId);
    assert.equal((await readLaunch(harness.controlRoot, current.attemptId)).producerId, current.ownerId);
    assert.throws(() => harness.supervisor.worker(first.attemptId), codeIs('stale-attempt'));

    admitTaskEvidence(harness, 'task-1');
    const accepted = await submitAccepted(harness, 'task-1');
    assert.equal(accepted.decision.status, 'accepted');
    assert.equal(accepted.packet.attemptId, current.attemptId);
    assert.equal(accepted.packet.producer.id, current.ownerId);
  } finally { harness.store.close(); }
});

test('a launch record that disagrees with the producing identity cannot re-claim the workspace', async () => {
  const harness = createHarness({ perTargetConcurrency: 1, runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    const handle = harness.runtime.attempts.get(attempt.attemptId)!.handle as RuntimeHandle;
    const hooks = harness.supervisor.runtimeHooks();
    assert.equal(await hooks.claim(structuredClone(handle)), true);

    const launchPath = `${harness.controlRoot}/launches/${attempt.attemptId}.json`;
    const launch = JSON.parse(await readFile(launchPath, 'utf8')) as LaunchFile;
    await writeFile(launchPath, `${JSON.stringify({ ...launch, producerId: 'forged-producer' })}\n`);
    assert.equal(await hooks.claim(structuredClone(handle)), false);
  } finally { harness.store.close(); }
});

test('producer identity is stable through reconciling and receipt-backed reconciliation, and the reconciling attempt stays closed', async () => {
  const harness = createHarness({
    perTargetConcurrency: 1,
    runtimeOptions: { steps: [{ at: 0, status: 'running' }], stopVerified: false },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const launched = latestAttempt(harness, 'task-1');
    admitTaskEvidence(harness, 'task-1');
    const candidate = { packet: packetFor(harness, 'task-1'), idempotencyKey: 'reconciling-probe' };

    const cancelled = await harness.supervisor.cancel(harness.run.runId);
    assert.equal(cancelled.run.state, 'active');
    const reconciling = harness.store.getAttempt(launched.attemptId);
    assert.equal(reconciling?.lifecycleState, 'reconciling');
    assert.equal(reconciling?.ownerId, launched.ownerId);
    assert.equal(reconciling?.leaseToken, launched.leaseToken);
    assert.equal(harness.store.getLease('task-1')?.ownerId, launched.ownerId);
    assert.equal(harness.supervisor.worker(launched.attemptId).identity.producerId, launched.ownerId);
    assert.equal((await readLaunch(harness.controlRoot, launched.attemptId)).producerId, launched.ownerId);
    await assert.rejects(() => harness.supervisor.submitResult(launched.attemptId, candidate), codeIs('stale-result'));

    harness.runtime.options.stopVerified = true;
    await harness.supervisor.recover(harness.run.runId);
    await harness.supervisor.tick(harness.run.runId);
    const finalized = harness.store.getAttempt(launched.attemptId);
    assert.equal(finalized?.lifecycleState, 'cancelled');
    assert.equal(finalized?.ownerId, launched.ownerId);
    assert.equal(finalized?.leaseToken, launched.leaseToken);
    assert.equal(harness.store.listAttempts(harness.run.runId).length, 1);
  } finally { harness.store.close(); }
});

test('the producer identity stays a valid bounded contract ID for a maximum-length controller identity', async () => {
  const controller = 'c'.repeat(128);
  const harness = createHarness({
    perTargetConcurrency: 1, ownerId: controller,
    runtimeOptions: { steps: [{ at: 0, status: 'running' }] },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    assert.notEqual(attempt.ownerId, controller);
    assert.equal(attempt.ownerId.length, 128);
    assert.match(attempt.ownerId, ID_PATTERN);
    assert.ok(attempt.ownerId.endsWith(`.worker.${attempt.attemptId}`));
    assert.equal(harness.supervisor.worker(attempt.attemptId).identity.producerId, attempt.ownerId);
    assert.equal((await readLaunch(harness.controlRoot, attempt.attemptId)).producerId, attempt.ownerId);
  } finally { harness.store.close(); }
});
