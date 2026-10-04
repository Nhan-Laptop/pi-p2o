import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalJson, digestJson,
  type AttemptRecord, type EvidenceKind, type EvidenceReceipt, type HandoffPacket,
} from '../../src/contracts/index.js';
import {
  PACKET_EVIDENCE_CLASSIFICATION, PACKET_EVIDENCE_KIND, authenticateControllerReceipt,
  createResultCollectorBridge, createWorkspacePacketSource, normalizeAttestedPacket, openEvidenceVault,
  publishHandoffReviews, sha256,
  type CollectorAttemptView, type CollectorGrant, type ControllerAttestationPolicy, type EvidenceSubmission, type EvidenceVault,
  type ResultCollectorBridge,
} from '../../src/evidence/index.js';
import { buildReport, renderMarkdown } from '../../src/reporting/index.js';
import { openStore, type DurableStore } from '../../src/store/index.js';
import {
  ManualClock, admitRunAndTasks, admitTaskEvidence, createHarness, h2Packet, latestAttempt, submitAccepted,
  type Harness,
} from '../orchestrator/fixtures.js';

const IMPLEMENTATION = sha256('p2o-result-collector-bridge-v1');
const CLAIM = 'Only accepted local fixture input reaches the handler';
const COLLECTOR = 'fixture-collector-1';

interface BridgeEnv {
  base: string; staging: string; workspaceRoot: string; store: DurableStore; vault: EvidenceVault;
  bridge: ResultCollectorBridge; harness: Harness; controller: ControllerAttestationPolicy; dispose(): void;
}

function bridgeGrant(store: DurableStore, attempt: CollectorAttemptView): CollectorGrant {
  const task = store.getTask(attempt.taskId), run = store.getRun(attempt.runId);
  assert.ok(task && run, 'bridge grant requires the durable task and run');
  return {
    collectorId: 'bridge-collector-1', role: 'collector',
    runId: run.runId, taskId: task.taskId, attemptId: attempt.attemptId,
    authorizationRef: run.authorization.reference, environmentId: task.scope.environmentId,
    configurationDigest: task.scope.configurationDigest, scopeDigest: digestJson(task.scope),
    inputDigests: [digestJson(task.scope.inputs), digestJson(task.question)],
    tool: { name: 'p2o-result-bridge', version: '1.0.0', implementationDigest: IMPLEMENTATION },
    toolGrantId: 'bridge-tool-grant-1', artifactRootIds: ['workspaces'],
    allowedKinds: [PACKET_EVIDENCE_KIND], allowedClassifications: [PACKET_EVIDENCE_CLASSIFICATION],
    validFrom: run.authorization.validFrom, expiresAt: run.authorization.expiresAt,
    originalEnvironment: true, modifications: [],
  };
}

function createEnv(): BridgeEnv {
  const base = mkdtempSync(join(tmpdir(), 'p2o-bridge-'));
  const staging = join(base, 'staging'), workspaceRoot = join(base, 'workspaces'), vaultRoot = join(base, 'vault');
  for (const path of [staging, workspaceRoot]) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
  const clock = new ManualClock();
  const store = openStore({ path: join(base, 'run.sqlite'), clock: () => clock.iso() });
  const vault = openEvidenceVault({
    root: vaultRoot, artifactRoots: { staging, workspaces: workspaceRoot }, workerWriteRoots: [workspaceRoot],
    clock: () => clock.iso(),
  });
  const bridge: ResultCollectorBridge = createResultCollectorBridge({
    vault, store, packets: createWorkspacePacketSource({ root: workspaceRoot, rootId: 'workspaces' }),
    grant: (attempt: CollectorAttemptView) => bridgeGrant(store, attempt), clock: () => clock.iso(),
  });
  const harness = createHarness({
    root: base, store, clock, results: bridge,
    runtimeOptions: { steps: [{ at: 0, status: 'running' }, { at: 50, status: 'settled' }] },
  });
  return {
    base, staging, workspaceRoot, store, vault, bridge, harness,
    controller: { collectorId: 'supervisor-a', toolName: 'p2o-supervisor', locatorRoot: harness.controlRoot },
    dispose() { try { harness.supervisor.dispose(); } catch { /* already disposed */ } try { vault.close(); } catch { /* already closed */ } store.close(); rmSync(base, { recursive: true, force: true }); },
  };
}

let sequence = 0;
function collect(env: BridgeEnv, attempt: AttemptRecord, evidenceId: string, kind: EvidenceKind, overrides: Partial<EvidenceSubmission> = {}): EvidenceReceipt {
  const task = env.store.getTask(attempt.taskId), run = env.store.getRun(attempt.runId);
  assert.ok(task && run, 'fixture collector requires the durable task and run');
  sequence += 1;
  const content = JSON.stringify({ fixture: evidenceId, kind, sequence, inert: true });
  const path = `${evidenceId}.json`;
  writeFileSync(join(env.staging, path), content, { mode: 0o600 });
  const handle = env.vault.issueCollector({
    collectorId: COLLECTOR, role: 'collector',
    runId: run.runId, taskId: task.taskId, attemptId: attempt.attemptId,
    authorizationRef: run.authorization.reference, environmentId: task.scope.environmentId,
    configurationDigest: task.scope.configurationDigest, scopeDigest: digestJson(task.scope),
    inputDigests: [task.scope.inputs[0].digest],
    tool: { name: 'inert-fixture-collector', version: '1', implementationDigest: sha256('inert-fixture-collector-v1') },
    toolGrantId: `fixture-grant-${sequence}`, artifactRootIds: ['staging'],
    allowedKinds: ['source', 'baseline', 'reproduction', 'negative-control', 'test', 'runtime', 'log', 'coverage', 'trace'],
    allowedClassifications: ['static-inference', 'independently-observed', 'hypothesis', 'unresolved'],
    validFrom: run.authorization.validFrom, expiresAt: run.authorization.expiresAt,
    originalEnvironment: true, modifications: [],
  });
  return env.vault.admit(handle, {
    evidenceId, idempotencyKey: evidenceId,
    artifact: { rootId: 'staging', path, expectedDigest: sha256(content), expectedBytes: Buffer.byteLength(content), mediaType: 'application/json' },
    operationInputDigest: digestJson({ fixture: evidenceId }),
    kind, classification: kind === 'source' ? 'static-inference' : 'independently-observed',
    summary: 'Inert authorized local fixture collector',
    collectedAt: env.harness.clock.iso(), method: 'fixed local fixture collector', toolOptions: [],
    originalEnvironment: true, modifications: [], metadata: { claimDigest: digestJson(CLAIM), surfaceId: 'handler', actorId: task.scope.actor.id },
    ...(kind === 'baseline' ? { test: { purpose: 'baseline' as const, outcome: 'passed' as const, successes: 1, attempts: 1, invariant: CLAIM, originalPolicy: true } } : {}),
    ...overrides,
  }).receipt;
}

interface Accepted {
  attempt: AttemptRecord; packetId: string; resultDigest: string; observed: NonNullable<AttemptRecord['observedRuntime']>;
  runtimeId: string; evidenceIds: string[]; workerBytes: Buffer;
}

/** Runs the real supervisor to settlement on a bridge-preserved H2 packet. */
async function runAccepted(env: BridgeEnv, mutatePacket?: (packet: HandoffPacket) => void): Promise<Accepted> {
  await admitRunAndTasks(env.harness, [env.harness.task('task-1')]);
  await env.harness.supervisor.tick(env.harness.run.runId);
  const attempt = latestAttempt(env.harness, 'task-1');
  const task = env.harness.store.getTask('task-1');
  assert.ok(task && attempt.observedRuntime, 'the supervisor must observe the launched attempt');
  const source = collect(env, attempt, 'bridge-source', 'source', { artifactIdentity: { digest: task.scope.inputs[0].digest, revision: task.inputRevision } });
  const baseline = collect(env, attempt, 'bridge-baseline', 'baseline');
  const packet = h2Packet({
    runId: task.runId, taskId: task.taskId, attemptId: attempt.attemptId, producerId: attempt.ownerId,
    scope: task.scope, question: task.question, inputRevision: task.inputRevision,
    requestedRuntime: attempt.requestedRuntime, observedRuntime: attempt.observedRuntime,
    evidenceIds: [source.evidenceId, baseline.evidenceId], baselineEvidenceIds: [baseline.evidenceId],
    createdAt: env.harness.clock.iso(), untestedScope: ['production impact not assessed'],
  });
  mutatePacket?.(packet);
  const packetPath = join(env.harness.supervisor.workspaceFor('task-1'), 'handoff.packet.json');
  writeFileSync(packetPath, JSON.stringify(packet), { mode: 0o600 });
  const workerBytes = readFileSync(packetPath);
  env.harness.clock.advance(100);
  const snapshot = await env.harness.supervisor.tick(env.harness.run.runId);
  assert.equal(snapshot.results.length, 1, 'the supervisor records exactly the collected candidate');
  const result = snapshot.results[0];
  const finalAttempt = env.harness.store.getAttempt(attempt.attemptId);
  assert.ok(finalAttempt?.observedRuntime);
  return {
    attempt: finalAttempt, packetId: result.packet.packetId, resultDigest: result.digest,
    observed: finalAttempt.observedRuntime, runtimeId: finalAttempt.observedRuntime.receiptEvidenceIds[0],
    evidenceIds: [source.evidenceId, baseline.evidenceId], workerBytes,
  };
}

test('the bridge admits vault-preserved bytes through the real supervisor and publishes controller-attested runtime', async () => {
  const env = createEnv();
  try {
    const accepted = await runAccepted(env);
    const results = env.store.listResults(env.harness.run.runId);
    assert.equal(results.length, 1);
    const result = results[0];
    assert.equal(result.decision.status, 'accepted', result.decision.reasons.map(r => r.code).join(', '));
    assert.equal(result.digest, digestJson(result.packet));
    // Vault receipts were imported as collector-trust store evidence with the vault bytes.
    for (const id of accepted.evidenceIds) {
      const stored = env.store.getEvidence(id), vaulted = env.vault.get(id);
      assert.ok(stored && vaulted, id);
      assert.equal(stored.provenance.trust, 'collector');
      assert.equal(stored.digest, vaulted.digest);
    }
    // The packet is preserved byte-for-byte (pre-redaction digest) and normalized exactly like the supervisor override.
    const preservation = env.bridge.preservation(accepted.attempt.attemptId);
    assert.ok(preservation, 'the bridge records what it preserved');
    assert.equal(env.vault.inspect(preservation.evidenceId)!.originalDigest, sha256(accepted.workerBytes));
    const preservedPacket = JSON.parse(env.vault.read(preservation.evidenceId).toString('utf8')) as unknown;
    assert.equal(digestJson(normalizeAttestedPacket(preservedPacket, result.packet.observedRuntime)), result.digest);
    assert.equal(digestJson(normalizeAttestedPacket(preservedPacket, accepted.observed)), result.digest);
    assert.equal(canonicalJson((preservedPacket as { observedRuntime: unknown }).observedRuntime) !== canonicalJson(result.packet.observedRuntime), true);
    // The supervisor runtime receipt is controller-owned, listed by the durable observation and never copied into the vault.
    const runtime = env.store.getEvidence(accepted.runtimeId);
    assert.ok(runtime);
    assert.equal(runtime.kind, 'runtime');
    assert.equal(runtime.provenance.collectorId, 'supervisor-a');
    assert.ok(accepted.observed.receiptEvidenceIds.includes(accepted.runtimeId));
    assert.deepEqual(authenticateControllerReceipt(runtime, accepted.attempt, env.controller), []);
    assert.equal(env.vault.get(accepted.runtimeId), undefined);
    // Publication authenticates the preserved packet and the controller receipt.
    const publication = publishHandoffReviews({
      vault: env.vault, store: env.store, runId: env.harness.run.runId, reviewerId: 'reviewer-1',
      now: env.harness.clock.iso(), controller: env.controller,
    });
    assert.equal(publication.reviews.length, 1);
    assert.equal(publication.reviews[0].decision.status, 'accepted', publication.reviews[0].decision.reasons.map(r => r.code).join(', '));
    assert.equal(publication.controllerReceipts.length, 1);
    // Reporting resolves the controller receipt without treating it as vault evidence.
    const report = buildReport({
      vault: env.vault, run: env.store.getRun(env.harness.run.runId), tasks: env.store.listTasks(env.harness.run.runId),
      attempts: env.store.listAttempts(env.harness.run.runId), handoffs: publication.reviews, findings: [],
      coveragePlan: [], coverage: [], generatedAt: env.harness.clock.iso(),
      controllerReceipts: publication.controllerReceipts, controller: env.controller,
    });
    assert.equal(report.processes[0].runtimeEvidenceVerified, true);
    assert.equal(report.processes[0].runtimeDiscrepancies.length, 0);
    const entry = report.evidence.find(e => e.evidenceId === accepted.runtimeId);
    assert.equal(entry?.attestation, 'controller');
    assert.equal(report.evidence.find(e => e.evidenceId === accepted.evidenceIds[0])?.attestation, 'vault');
    assert.match(renderMarkdown(report), /controller-attested/);
  } finally { env.dispose(); }
});

test('forged references and worker-forged runtime receipts are returned for evidence and never promoted', async () => {
  const env = createEnv();
  try {
    await admitRunAndTasks(env.harness, [env.harness.task('task-1')]);
    await env.harness.supervisor.tick(env.harness.run.runId);
    const attempt = latestAttempt(env.harness, 'task-1');
    const task = env.harness.store.getTask('task-1');
    assert.ok(task && attempt.observedRuntime);
    const source = collect(env, attempt, 'bridge-source', 'source');
    // A worker-authored (worker-trust) receipt may exist in the legacy store; it must never be promoted.
    env.store.putEvidence({ ...source, evidenceId: 'worker-forged', provenance: { ...source.provenance, trust: 'worker' as const } });
    const claimed = h2Packet({
      runId: task.runId, taskId: task.taskId, attemptId: attempt.attemptId, producerId: attempt.ownerId,
      scope: task.scope, question: task.question, inputRevision: task.inputRevision,
      requestedRuntime: attempt.requestedRuntime, observedRuntime: attempt.observedRuntime,
      evidenceIds: [source.evidenceId, 'worker-forged', 'never-collected'], baselineEvidenceIds: ['never-collected'],
      createdAt: env.harness.clock.iso(), untestedScope: ['production impact not assessed'],
    });
    // A worker also cannot author its own runtime attestation: the forged receipt id is discarded.
    claimed.observedRuntime = { ...claimed.observedRuntime, attestation: 'attested', receiptEvidenceIds: ['worker-runtime-forgery'] };
    writeFileSync(join(env.harness.supervisor.workspaceFor('task-1'), 'handoff.packet.json'), JSON.stringify(claimed), { mode: 0o600 });
    env.harness.clock.advance(100);
    const snapshot = await env.harness.supervisor.tick(env.harness.run.runId);
    const result = snapshot.results[0];
    assert.equal(result.decision.status, 'returned-for-evidence');
    assert.ok(result.decision.reasons.some(r => r.code === 'missing-reference'));
    // The supervisor's durable observation replaced the whole worker claim.
    const finalAttempt = env.harness.store.getAttempt(attempt.attemptId);
    assert.ok(finalAttempt?.observedRuntime);
    assert.equal(canonicalJson(result.packet.observedRuntime), canonicalJson(finalAttempt.observedRuntime));
    assert.ok(!result.packet.observedRuntime.receiptEvidenceIds.includes('worker-runtime-forgery'));
    // Forged ids never enter the vault, and the worker-trust store receipt was neither imported nor relabelled.
    for (const forged of ['worker-forged', 'never-collected', 'worker-runtime-forgery']) assert.equal(env.vault.get(forged), undefined, forged);
    assert.equal(env.store.getEvidence('worker-forged')!.provenance.trust, 'worker');
    assert.equal(env.vault.list(env.harness.run.runId).some(receipt => receipt.evidenceId === 'worker-forged'), false);
    assert.ok(env.store.listEvents({ runId: env.harness.run.runId }).some(event => event.type === 'orchestrator.result-admitted' && (event.payload as { status?: string }).status === 'returned-for-evidence'));
  } finally { env.dispose(); }
});

test('tampered controller observation documents fail independent attestation and block acceptance', async () => {
  const env = createEnv();
  try {
    const accepted = await runAccepted(env);
    const runtime = env.store.getEvidence(accepted.runtimeId);
    assert.ok(runtime);
    const documentPath = join(env.harness.controlRoot, 'receipts', `${accepted.runtimeId}.json`);
    assert.deepEqual(authenticateControllerReceipt(runtime, accepted.attempt, env.controller), []);
    const tampered = readFileSync(documentPath);
    tampered[Math.floor(tampered.length / 2)] ^= 0x01;
    writeFileSync(documentPath, tampered, { mode: 0o600 });
    const issues = authenticateControllerReceipt(runtime, accepted.attempt, env.controller);
    assert.ok(issues.includes('controller-digest'), issues.join(', '));
    // Publication drops the unverifiable runtime receipt, so the packet review returns for evidence.
    const publication = publishHandoffReviews({
      vault: env.vault, store: env.store, runId: env.harness.run.runId, reviewerId: 'reviewer-1',
      now: env.harness.clock.iso(), controller: env.controller,
    });
    assert.equal(publication.controllerReceipts.length, 0);
    assert.equal(publication.reviews[0].decision.status, 'returned-for-evidence');
    assert.ok(publication.reviews[0].decision.reasons.some(r => ['trusted-reference', 'runtime-receipt', 'receipt-input-scope'].includes(r.code)));
  } finally { env.dispose(); }
});

test('publication refuses a store-accepted packet that the bridge never preserved', async () => {
  const harness = createHarness({ runtimeOptions: { steps: [{ at: 0, status: 'running' }, { at: 30, status: 'settled' }] } });
  let vault: EvidenceVault | undefined;
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    admitTaskEvidence(harness, 'task-1');
    const admission = await submitAccepted(harness, 'task-1');
    assert.equal(admission.decision.status, 'accepted');
    const vaultRoot = join(harness.root, 'vault');
    mkdirSync(vaultRoot, { recursive: true, mode: 0o700 });
    vault = openEvidenceVault({
      root: vaultRoot, artifactRoots: { workspaces: harness.workspaceRoot }, workerWriteRoots: [harness.workspaceRoot],
      clock: () => harness.clock.iso(),
    });
    assert.throws(() => publishHandoffReviews({
      vault: vault!, store: harness.store, runId: harness.run.runId, reviewerId: 'reviewer-1',
      now: harness.clock.iso(), controller: { collectorId: 'supervisor-a', toolName: 'p2o-supervisor', locatorRoot: harness.controlRoot },
    }), /packet-not-preserved/);
  } finally { try { vault?.close(); } catch { /* already closed */ } harness.supervisor.dispose(); harness.store.close(); rmSync(harness.root, { recursive: true, force: true }); }
});
