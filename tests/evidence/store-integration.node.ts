import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { digestJson, type HandoffPacket } from '../../src/contracts/index.js';
import { reviewHandoff } from '../../src/evidence/index.js';
import { openStore } from '../../src/store/index.js';
import { collectContractEvidence, createHarness, packetFixture, reviewContext, type Harness } from './fixtures.js';

const MAX_MS = 16 * 60 * 60 * 1000;
/** Proves vault receipts are store-shaped and the shared store's own gate accepts the reviewed packet. */
test('vault receipts and packets integrate with the shared durable store', () => {
  const h: Harness = createHarness();
  mkdirSync(join(h.base, 'store'), { recursive: true, mode: 0o700 });
  const store = openStore({ path: join(h.base, 'store', 'control.db'), clock: () => h.task.createdAt });
  try {
    const workspace = join(realpathSync(h.base), 'task-1');
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const run = { ...h.run, state: 'active' as const };
    const task = { ...h.task, workspace, lifecycleState: 'queued' as const, packetState: 'draft' as const };
    store.createRun(run);
    store.createTask(task);
    const lease = store.beginAttempt({ taskId: task.taskId, ownerId: h.attempt.ownerId, attemptId: h.attempt.attemptId, leaseMs: MAX_MS });
    assert.equal(lease.attempt.lifecycleState, 'starting');
    collectContractEvidence(h);
    const packet = packetFixture(h, 'H4') as HandoffPacket;
    // Only store receipts that carry an authenticated collector identity and verified bytes.
    for (const id of packet.evidenceIds) {
      const receipt = h.vault.get(id);
      assert.ok(receipt, id);
      const stored = store.putEvidence(receipt);
      assert.equal(stored.digest, receipt.digest);
      assert.equal(stored.provenance.trust, 'collector');
    }
    assert.equal(store.listEvidence(run.runId).length, packet.evidenceIds.length);
    const review = reviewHandoff(h.vault, packet, reviewContext(h));
    assert.equal(review.decision.status, 'accepted', review.decision.reasons.map(r => r.code).join(', '));
    // A worker-trust receipt may exist in the legacy store, but it can never satisfy this module's gates.
    const observation = h.vault.get('observation')!;
    store.putEvidence({ ...observation, evidenceId: 'worker-authored', provenance: { ...observation.provenance, trust: 'worker' as const } });
    const claimed = { ...packet, packetId: 'packet-worker-claim', evidenceIds: ['source', 'worker-authored'], limits: { ...packet.limits, negativeControlEvidenceIds: [] } } as HandoffPacket;
    const refused = reviewHandoff(h.vault, claimed, reviewContext(h));
    assert.equal(refused.decision.status, 'returned-for-evidence');
    assert.ok(refused.decision.reasons.some(r => ['trusted-reference', 'missing-reference'].includes(r.code)));
    // The shared store validates packet structure, not collector authenticity: never put worker receipts there.
    assert.equal(store.listEvidence(run.runId).length, packet.evidenceIds.length + 1);
    const admitted = store.admitResult({ packet, idempotencyKey: 'review-1', leaseToken: lease.lease.token, reviewerId: 'reviewer-1' });
    assert.equal(admitted.duplicate, false);
    assert.equal(admitted.decision.status, 'accepted', admitted.decision.reasons.map(r => r.code).join(', '));
    assert.equal(admitted.digest, digestJson(packet));
    assert.equal(store.getTask(task.taskId)!.packetState, 'accepted');
    const replay = store.admitResult({ packet, idempotencyKey: 'review-1', leaseToken: lease.lease.token, reviewerId: 'reviewer-1' });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.resultId, admitted.resultId);
  } finally { store.close(); h.dispose(); }
});
