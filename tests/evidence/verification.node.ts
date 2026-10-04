import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestJson, type HandoffPacket } from '../../src/contracts/index.js';
import { assertFindingReview, assertHandoffReview, reviewHandoff, validateFinding, type HandoffReview } from '../../src/evidence/index.js';
import { collectContractEvidence, collectStaticPropertyEvidence, createHarness, findingFixture, packetFixture, reviewContext, SOURCE, STATIC_CLAIM, STATIC_SOURCE_PROOF, CLAIM } from './fixtures.js';

function accepted(h: ReturnType<typeof createHarness>, contract: HandoffPacket['contract'] = 'H4'): HandoffReview {
  collectContractEvidence(h);
  return reviewHandoff(h.vault, packetFixture(h, contract), reviewContext(h));
}
test('H4 packet with authenticated receipts is accepted through the shared gate', () => {
  const h = createHarness();
  try {
    const review = accepted(h);
    assert.equal(review.decision.status, 'accepted');
    assert.ok(review.decision.acceptedDigest);
    assert.equal(review.decision.acceptedDigest, digestJson(review.packet!));
    assert.doesNotThrow(() => assertHandoffReview(review, h.vault));
  } finally { h.dispose(); }
});
test('H1, H2, H3, H5 and H6 fixtures are executable, not stubs', () => {
  const h = createHarness();
  try {
    for (const contract of ['H1', 'H2', 'H3', 'H5', 'H6'] as const) {
      const review = reviewHandoff(h.vault, packetFixture(h, contract), reviewContext(h));
      assert.equal(review.decision.status, 'returned-for-evidence', contract);
      assert.ok(review.decision.reasons.length > 0);
    }
    collectContractEvidence(h);
    for (const contract of ['H1', 'H2', 'H3', 'H5', 'H6'] as const) {
      const review = reviewHandoff(h.vault, packetFixture(h, contract), reviewContext(h));
      assert.equal(review.decision.status, 'accepted', `${contract}: ${review.decision.reasons.map(r => r.code).join(', ')}`);
    }
  } finally { h.dispose(); }
});
test('missing controls, forged references and foreign-run evidence are returned with a question', () => {
  const h = createHarness();
  try {
    collectContractEvidence(h);
    const missing = packetFixture(h, 'H6') as Extract<HandoffPacket, { contract: 'H6' }>;
    missing.details.enforcementEvidenceIds = [];
    missing.evidenceIds = missing.evidenceIds.filter(id => id !== 'enforcement');
    const review = reviewHandoff(h.vault, missing, reviewContext(h));
    assert.equal(review.decision.status, 'returned-for-evidence');
    assert.ok(review.decision.reasons.some(r => r.code === 'H6-enforcement'));
    assert.ok(review.decision.unansweredQuestions.every(q => q.length > 0));
    const forged = packetFixture(h, 'H4');
    (forged as { evidenceIds: string[] }).evidenceIds = ['not-collected'];
    const forgedReview = reviewHandoff(h.vault, forged, reviewContext(h));
    assert.equal(forgedReview.decision.status, 'returned-for-evidence');
    assert.ok(forgedReview.decision.reasons.some(r => ['missing-reference', 'trusted-reference'].includes(r.code)));
  } finally { h.dispose(); }
});
test('H6 deployed hashes, active enforcement and controls must agree', () => {
  const h = createHarness();
  try {
    const review = accepted(h, 'H6');
    assert.equal(review.decision.status, 'accepted', review.decision.reasons.map(r => r.code).join(', '));
    const tampered = packetFixture(h, 'H6') as Extract<HandoffPacket, { contract: 'H6' }>;
    tampered.details.deploymentInventory[0].artifactDigest = 'd'.repeat(64);
    const returned = reviewHandoff(h.vault, tampered, reviewContext(h));
    assert.equal(returned.decision.status, 'returned-for-evidence');
    assert.ok(returned.decision.reasons.some(r => ['H6-shipped-active', 'H6-comparable-controls', 'H6-comparability'].includes(r.code)));
    const staticOnly = packetFixture(h, 'H6') as Extract<HandoffPacket, { contract: 'H6' }>;
    staticOnly.outcome = 'static-only';
    staticOnly.classification = 'static-inference';
    staticOnly.evidenceIds = ['source'];
    staticOnly.details.closure = 'unverified';
    const retained = reviewHandoff(h.vault, staticOnly, reviewContext(h));
    assert.equal(retained.decision.status, 'accepted', retained.decision.reasons.map(r => r.code).join(', '));
    assert.equal(retained.packet!.outcome, 'static-only');
  } finally { h.dispose(); }
});
test('producer self-review, stale attempts and expired attempts are returned', () => {
  const h = createHarness();
  try {
    collectContractEvidence(h);
    const selfReview = reviewHandoff(h.vault, packetFixture(h, 'H4'), { ...reviewContext(h), reviewerId: h.attempt.ownerId });
    assert.equal(selfReview.decision.status, 'returned-for-evidence');
    assert.ok(selfReview.decision.reasons.some(r => r.code === 'reviewer-identity'));
    const expired = { ...h.attempt, deadlineAt: '2026-10-02T09:00:00.000Z' };
    const stale = reviewHandoff(h.vault, packetFixture(h, 'H4'), { ...reviewContext(h), attempt: expired });
    assert.equal(stale.decision.status, 'returned-for-evidence');
    assert.ok(stale.decision.reasons.some(r => r.code === 'stale-attempt'));
    const stopped = { ...h.attempt, lifecycleState: 'cancelled' as const };
    const cancelled = reviewHandoff(h.vault, packetFixture(h, 'H4'), { ...reviewContext(h), attempt: stopped });
    assert.equal(cancelled.decision.status, 'returned-for-evidence');
    assert.ok(cancelled.decision.reasons.some(r => r.code === 'stale-attempt'));
  } finally { h.dispose(); }
});
test('receipts collected against a different input revision or authorization are returned', () => {
  const h = createHarness();
  try {
    collectContractEvidence(h);
    h.collect('other-input', 'observation', {}, { inputDigests: ['b'.repeat(64)] });
    const packet = packetFixture(h, 'H4');
    (packet as { evidenceIds: string[] }).evidenceIds = ['other-input'];
    const review = reviewHandoff(h.vault, packet, reviewContext(h));
    assert.equal(review.decision.status, 'returned-for-evidence');
    assert.ok(review.decision.reasons.some(r => r.code === 'receipt-input-scope'));
  } finally { h.dispose(); }
});
test('static-only and unresolved findings are retained instead of promoted', () => {
  const h = createHarness();
  try {
    const staticFinding = findingFixture(h, 'supported-static');
    const staticReview = validateFinding(h.vault, staticFinding, { reviewerId: 'reviewer-1', now: h.task.createdAt });
    assert.equal(staticReview.status, 'returned-for-evidence');
    collectStaticPropertyEvidence(h);
    const bound = validateFinding(h.vault, staticFinding, { reviewerId: 'reviewer-1', now: h.task.createdAt });
    assert.equal(bound.status, 'accepted', bound.issues.map(i => i.code).join(', '));
    assert.equal(bound.finding!.state, 'supported-static');
    assert.equal(bound.finding!.classification, 'static-inference');
    const promoted = { ...staticFinding, classification: 'independently-observed' as const };
    const refused = validateFinding(h.vault, promoted, { reviewerId: 'reviewer-1', now: h.task.createdAt });
    assert.equal(refused.status, 'returned-for-evidence');
    const unresolved = findingFixture(h, 'unresolved');
    assert.equal(validateFinding(h.vault, unresolved, { reviewerId: 'reviewer-1', now: h.task.createdAt }).status, 'returned-for-evidence');
    assert.doesNotThrow(() => assertFindingReview(bound, h.vault));
    assert.throws(() => assertFindingReview({ ...bound, status: 'accepted' }, h.vault), /receipt-backed/);
    assert.equal(SOURCE.length > 0, true);
  } finally { h.dispose(); }
});
test('source observation or claimDigest agreement alone never demonstrates the static property', () => {
  const h = createHarness();
  try {
    h.collect('source', 'source', { metadata: { claimDigest: digestJson(STATIC_CLAIM) } });
    const review = validateFinding(h.vault, findingFixture(h, 'supported-static'), { reviewerId: 'reviewer-1', now: h.task.createdAt });
    assert.equal(review.status, 'returned-for-evidence');
    assert.ok(review.issues.some(i => i.code === 'static-claim-binding'));
    assert.equal(review.finding!.state, 'supported-static', 'a refused source hypothesis must not become reproduced');
  } finally { h.dispose(); }
});
test('static source spans/hashes/hypotheses and dynamic vulnerability claims require independent evidence semantics', () => {
  for (const patch of [{ fileHash: 'd'.repeat(64) }, { endLine: 100 }, { excerpt: 'absent sink' }, { hypothesis: '' }]) {
    const h = createHarness();
    try {
      h.collect('source', 'source', { metadata: { claimDigest: digestJson(STATIC_CLAIM), sourceClaim: { ...STATIC_SOURCE_PROOF, ...patch } } });
      const review = validateFinding(h.vault, findingFixture(h, 'supported-static'), { reviewerId: 'reviewer-1', now: h.task.createdAt });
      assert.equal(review.status, 'returned-for-evidence', JSON.stringify(patch));
      assert.ok(review.issues.some(i => i.code === 'static-claim-binding'), JSON.stringify(review.issues));
    } finally { h.dispose(); }
  }
  const h = createHarness();
  try {
    collectStaticPropertyEvidence(h);
    const claimedVulnerability = validateFinding(h.vault, { ...findingFixture(h, 'supported-static'), claim: CLAIM }, { reviewerId: 'reviewer-1', now: h.task.createdAt });
    assert.equal(claimedVulnerability.status, 'returned-for-evidence', 'a demonstrated source property does not demonstrate its security hypothesis');
    assert.ok(claimedVulnerability.issues.some(i => i.code === 'static-claim-binding'));
    const promoted = validateFinding(h.vault, { ...findingFixture(h, 'supported-static'), state: 'reproduced', classification: 'independently-observed', negativeControlEvidenceIds: ['source'] }, { reviewerId: 'reviewer-1', now: h.task.createdAt });
    assert.equal(promoted.status, 'returned-for-evidence');
    assert.ok(promoted.issues.some(i => i.code === 'finding-reproduction'));
  } finally { h.dispose(); }
});
test('finding claims require a collector receipt bound to the exact claim', () => {
  const h = createHarness();
  try {
    const receipt = h.collect('repro', 'reproduction');
    assert.equal(receipt.test!.invariant!.startsWith('A foreign actor'), true);
    const unrelated = { ...findingFixture(h), claim: 'A different unproven claim' };
    const review = validateFinding(h.vault, unrelated, { reviewerId: 'reviewer-1', now: h.task.createdAt });
    assert.equal(review.status, 'returned-for-evidence');
    assert.ok(review.issues.some(i => i.code === 'claim-binding' || i.code === 'reproduction-denominator'));
  } finally { h.dispose(); }
});
test('failed or inconclusive samples cannot hide behind a passing reproduction', () => {
  const h = createHarness();
  try {
    h.collect('repro', 'reproduction');
    h.collect('repro-partial', 'reproduction', { test: { purpose: 'reproduction', outcome: 'inconclusive', successes: 0, attempts: 1, invariant: findingFixture(h).claim, originalPolicy: true } });
    h.collect('negative', 'negative-control');
    const finding = { ...findingFixture(h), evidenceIds: ['repro', 'repro-partial'] };
    const review = validateFinding(h.vault, finding, { reviewerId: 'reviewer-1', now: h.task.createdAt });
    assert.equal(review.status, 'returned-for-evidence');
    assert.ok(review.issues.some(i => i.code === 'reproduction-denominator'));
  } finally { h.dispose(); }
});
test('missing, failed or unrelated negative controls block verification', () => {
  const h = createHarness();
  try {
    h.collect('repro', 'reproduction');
    h.collect('failed-control', 'negative-control', { test: { purpose: 'negative-control', outcome: 'failed', successes: 0, attempts: 1, invariant: 'A foreign actor can read another account record', originalPolicy: true } });
    const review = validateFinding(h.vault, { ...findingFixture(h), negativeControlEvidenceIds: ['failed-control'] }, { reviewerId: 'reviewer-1', now: h.task.createdAt });
    assert.equal(review.status, 'returned-for-evidence');
    assert.ok(review.issues.some(i => i.code === 'control-comparability'));
  } finally { h.dispose(); }
});
test('independent validation requires a distinct verifier collector and clean environment receipt', () => {
  const main = createHarness();
  try {
    main.collect('repro', 'reproduction');
    main.collect('negative', 'negative-control');
    main.collect('verifier-repro', 'reproduction', {}, { collectorId: 'collector-1' });
    const finding = { ...findingFixture(main), state: 'independently-validated' as const, verifier: { identity: 'collector-1', attemptId: main.attempt.attemptId, environmentId: 'lab-1', evidenceIds: ['verifier-repro'] } };
    const review = validateFinding(main.vault, finding, { reviewerId: 'reviewer-1', now: main.task.createdAt });
    assert.equal(review.status, 'returned-for-evidence');
    assert.ok(review.issues.some(i => ['independent-verifier', 'verifier-authentication', 'finding-independence'].includes(i.code)));
    const noEnvironment = { ...findingFixture(main), state: 'independently-validated' as const, verifier: { identity: 'verifier-9', attemptId: 'attempt-9', environmentId: 'lab-9', evidenceIds: ['repro'] } };
    assert.equal(validateFinding(main.vault, noEnvironment, { reviewerId: 'reviewer-1', now: main.task.createdAt }).status, 'returned-for-evidence');
  } finally { main.dispose(); }
});
