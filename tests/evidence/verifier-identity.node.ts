import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  digestJson, findingSchema, taskSchema,
  type JsonObject, type TaskManifest,
} from '../../src/contracts/index.js';
import {
  openEvidenceVault, replayFinding, sha256,
  type CleanReplayBroker, type CleanReplaySession, type EvidenceVault, type LocalReplayRecipe, type ReplayRequest,
} from '../../src/evidence/index.js';
import type { ToolReceipt, ToolResult } from '../../src/tools/types.js';
import {
  CONFIG_HASH, HASH, createHarness, fixtureRun, latestAttempt, type Harness,
} from '../orchestrator/fixtures.js';

import { scopedReplayPolicyFixture } from './scoped-fixtures.js';
const CLAIM = 'A foreign actor can read another account record through the bounded fixture route';
const BROKER = sha256('inert-verifier-broker-v1');
const GRANT_ID = 'verifier-tool-grant-1';
const PORT = 8123;
const PRODUCER_ENV = 'lab-1';
const VERIFIER_ENV = 'lab-verify';

function verifierTask(harness: Harness): TaskManifest {
  return taskSchema.parse({
    ...harness.task('task-verifier'),
    question: {
      text: 'Does the bounded local fixture reproduce the claimed foreign read?',
      ifTrue: 'the violation observable appears',
      ifFalse: 'only the original-policy denial appears',
    },
    skills: ['independent-verification'],
    scope: {
      authorizationRef: harness.run.authorization.reference,
      targetIds: ['fixture-lab'],
      actor: { id: 'verifier-actor', privileges: ['read-only'] },
      boundary: 'authorized local fixture only',
      isolation: 'inert local lab',
      recovery: 'discard replay outputs',
      environmentId: VERIFIER_ENV,
      configurationDigest: CONFIG_HASH,
      inputs: [{ id: 'fixture', digest: HASH, locator: 'fixtures/input.ts', revision: 'r1' }],
    },
    allowedActions: ['read'],
  });
}

/** Producing-attempt receipts: one passing reproduction and one comparable negative control. */
function collectProducingEvidence(vault: EvidenceVault, harness: Harness, attempt: { runId: string; taskId: string; attemptId: string; ownerId: string }): string[] {
  const authorize = harness.run.authorization;
  const collect = (evidenceId: string, kind: 'reproduction' | 'negative-control'): string => {
    const content = JSON.stringify({ fixture: evidenceId, kind, inert: true });
    const path = `${evidenceId}.json`;
    writeFileSync(join(harness.root, 'staging', path), content, { mode: 0o600 });
    const handle = vault.issueCollector({
      collectorId: attempt.ownerId, role: 'collector',
      runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.attemptId,
      authorizationRef: authorize.reference, environmentId: PRODUCER_ENV, configurationDigest: CONFIG_HASH,
      scopeDigest: sha256('producer-execution-policy-v1'), inputDigests: [HASH],
      tool: { name: 'inert-producing-collector', version: '1', implementationDigest: sha256('inert-producing-collector-v1') },
      toolGrantId: `producer-grant-${kind}`, artifactRootIds: ['staging'],
      allowedKinds: ['reproduction', 'negative-control'], allowedClassifications: ['independently-observed'],
      validFrom: authorize.validFrom, expiresAt: authorize.expiresAt, originalEnvironment: true, modifications: [],
    });
    return vault.admit(handle, {
      evidenceId, idempotencyKey: evidenceId,
      artifact: { rootId: 'staging', path, expectedDigest: sha256(content), expectedBytes: Buffer.byteLength(content), mediaType: 'application/json' },
      operationInputDigest: digestJson({ fixture: evidenceId }),
      kind, classification: 'independently-observed', summary: 'Inert producing-attempt observation',
      collectedAt: harness.clock.iso(), method: 'fixed local fixture collector', toolOptions: [],
      originalEnvironment: true, modifications: [], metadata: { claimDigest: digestJson(CLAIM), surfaceId: 'handler', actorId: 'local-reader' },
      test: { purpose: kind, outcome: 'passed', successes: 1, attempts: 1, invariant: CLAIM, originalPolicy: true, targetId: 'fixture', artifactDigest: HASH },
    }).receipt.evidenceId;
  };
  return [collect('repro', 'reproduction'), collect('negative', 'negative-control')];
}

interface BrokerOptions { vault: EvidenceVault; staging: string; harness: Harness; verifierTask: TaskManifest; verifierAttempt: { runId: string; taskId: string; attemptId: string; ownerId: string } }

function respond(mode: 'vulnerable', pathname: string): { status: number; body: JsonObject } {
  if (pathname === '/own') return { status: 200, body: { marker: 'own', ok: true } };
  if (pathname === '/control-foreign') return { status: 403, body: { marker: 'denied' } };
  if (pathname === '/foreign') return mode === 'vulnerable' ? { status: 200, body: { marker: 'foreign-marker' } } : { status: 403, body: { marker: 'denied' } };
  return { status: 404, body: { marker: 'missing' } };
}

/** PURE fixed-response verifier session with a real issued policy; not network, sandbox or target-reset qualification. */
function verifierBroker(options: BrokerOptions): CleanReplayBroker {
  const { vault, staging, harness, verifierTask: task, verifierAttempt: attempt } = options;
  const verifierId = attempt.ownerId;
  const approvedRecipe = recipe();
  const { policy, context } = scopedReplayPolicyFixture({ run: harness.run, task, attempt, targetId: 'fixture-lab',
    accountId: 'verifier-actor', grantId: GRANT_ID, now: () => harness.clock.now() });
  const scopeDigest = policy.scopeDigest;
  let ordinal = 0;
  const admitRuntime = (evidenceId: string, metadata: JsonObject, content: string): string => {
    const path = `${evidenceId}.json`;
    writeFileSync(join(staging, path), content, { mode: 0o600 });
    const handle = vault.issueCollector({
      collectorId: verifierId, role: 'verifier',
      runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.attemptId,
      authorizationRef: task.scope.authorizationRef, environmentId: task.scope.environmentId,
      configurationDigest: task.scope.configurationDigest, scopeDigest, inputDigests: [HASH],
      toolGrantId: GRANT_ID, tool: { name: 'http.request', version: '1.0.0', implementationDigest: BROKER },
      artifactRootIds: ['staging'], allowedKinds: ['runtime'], allowedClassifications: ['independently-observed'],
      validFrom: harness.run.authorization.validFrom, expiresAt: harness.run.authorization.expiresAt,
      originalEnvironment: true, modifications: [],
    });
    return vault.admit(handle, {
      evidenceId, idempotencyKey: evidenceId,
      artifact: { rootId: 'staging', path, expectedDigest: sha256(content), expectedBytes: Buffer.byteLength(content), mediaType: 'application/json' },
      operationInputDigest: digestJson({ fixture: evidenceId }),
      kind: 'runtime', classification: 'independently-observed', summary: 'Inert verifier environment observation',
      collectedAt: harness.clock.iso(), method: 'inert qualified fixture broker', toolOptions: [],
      originalEnvironment: true, modifications: [], metadata,
    }).receipt.evidenceId;
  };
  const environmentReceiptId = admitRuntime('verifier-environment', { independentSession: true, targetReset: false, recipeDigest: digestJson(approvedRecipe),
    qualification: 'inert independent verifier session; no target reset' }, JSON.stringify({ independentSession: true, targetReset: false, qualification: 'pure fixed response fixture' }));
  return {
    async prepare(request: ReplayRequest): Promise<CleanReplaySession> {
      assert.equal(request.verifierId, verifierId);
      assert.equal(request.recipeDigest, digestJson(approvedRecipe));
      return {
        verificationPolicy: policy,
        environmentReceiptId,
        context: { runId: request.task.runId, taskId: request.task.taskId, attemptId: request.attempt.attemptId, grantId: GRANT_ID },
        artifactRootId: 'staging',
        httpTool: { name: 'http.request', version: '1.0.0', implementationDigest: BROKER },
        broker: {
          async execute({ context: executionContext, input }): Promise<ToolResult> {
            const operation = input as { url: string; accountId: string } & JsonObject;
            assert.deepEqual(executionContext, context);
            policy.assertRequest(executionContext, 'fixture-lab', operation);
            const { status, body } = respond('vulnerable', new URL(operation.url).pathname);
            const data = { kind: 'http', status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
            const content = JSON.stringify(data), path = `${request.replayId}-${ordinal += 1}.json`;
            writeFileSync(join(staging, path), content, { mode: 0o600 });
            const artifact = { path, sha256: sha256(content), bytes: Buffer.byteLength(content), mediaType: 'application/json' as const, redacted: true as const };
            const receipt: ToolReceipt = {
              version: 1,
              context: { runId: request.task.runId, taskId: request.task.taskId, attemptId: request.attempt.attemptId, grantId: GRANT_ID },
              tool: { id: 'http.request', version: '1.0.0', implementationDigest: BROKER }, scopeDigest,
              configurationDigest: task.scope.configurationDigest, inputDigest: digestJson(input), startedAt: harness.clock.iso(), finishedAt: harness.clock.iso(),
              outcome: 'collected', targets: ['fixture-lab'],
              budgets: { 'fixture-lab': { requests: ordinal, bytes: artifact.bytes, active: 0, windowRequests: ordinal } },
              artifacts: [artifact], isolation: 'inert-in-process-fixture-not-a-sandbox', classification: 'observation-not-verified-finding',
            };
            return { data, artifact, receipt };
          },
        },
        async close() { return { receiptEvidenceId: admitRuntime('verifier-termination', { terminationConfirmed: true }, JSON.stringify({ terminated: true })) }; },
      };
    },
  };
}

function recipe(): LocalReplayRecipe {
  const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;
  return {
    recipeId: 'replay-foreign-read', fixtureId: 'fixture', targetId: 'fixture-lab', invariant: CLAIM, inputDigests: [HASH],
    baseline: { input: { url: url('/own'), accountId: 'verifier-actor' }, expected: { status: 200, bodyIncludes: 'own' } },
    negativeControl: { input: { url: url('/control-foreign'), accountId: 'verifier-actor' }, expected: { status: 403, bodyIncludes: 'denied' } },
    probe: { input: { url: url('/foreign'), accountId: 'verifier-actor' }, violation: { status: 200, bodyIncludes: 'foreign-marker' }, safe: { status: 403, bodyIncludes: 'denied' } },
  };
}

test('a real verifier attempt identity drives replayFinding with no identity workaround, and cross identity stays refused', async () => {
  const harness = createHarness({
    runtimeOptions: { steps: [{ at: 0, status: 'running' }] },
    runOverrides: {
      authorization: {
        ...fixtureRun().authorization,
        targets: [
          { id: 'fixture', kind: 'artifact', locator: 'fixtures/input.ts', digest: HASH, revision: 'r1' },
          { id: 'fixture-lab', kind: 'lab', locator: `http://127.0.0.1:${PORT}/` },
        ],
        allowedActions: ['review', 'local-test', 'read'],
      },
      // Owner fixture explicitly budgets the three replay observations, rather than inventing authority at execution.
      budgets: { ...fixtureRun().budgets, targetRequestLimits: { fixture: 5, 'fixture-lab': 3 } },
      allowedCapabilities: [...fixtureRun().allowedCapabilities, 'http.request'],
    },
  });
  const staging = join(harness.root, 'staging');
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  mkdirSync(join(harness.root, 'vault'), { recursive: true, mode: 0o700 });
  const vault = openEvidenceVault({ root: join(harness.root, 'vault'), artifactRoots: { staging }, workerWriteRoots: [staging], clock: () => harness.clock.iso() });
  try {
    await harness.supervisor.admitRun({ manifest: harness.run, mode: 'managed', perTargetConcurrency: { fixture: 1, 'fixture-lab': 1 } });
    await harness.supervisor.admitTask({ manifest: harness.task('task-producer'), role: 'worker' });
    await harness.supervisor.admitTask({ manifest: verifierTask(harness), role: 'verifier' });
    for (let pass = 0; pass < 4 && harness.store.listAttempts(harness.run.runId).length < 2; pass += 1) await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.store.listAttempts(harness.run.runId).length, 2, 'both the worker and verifier attempts must be launched');

    const producer = latestAttempt(harness, 'task-producer');
    const verifier = latestAttempt(harness, 'task-verifier');
    const verifierTaskRecord = harness.store.getTask('task-verifier');
    assert.ok(verifierTaskRecord);
    assert.equal(producer.lifecycleState, 'running');
    assert.equal(verifier.lifecycleState, 'running');
    // Per-attempt producing identity: controller prefix, role and attempt id, never shared between attempts.
    assert.equal(producer.ownerId, `supervisor-a.worker.${producer.attemptId}`);
    assert.equal(verifier.ownerId, `supervisor-a.verifier.${verifier.attemptId}`);
    assert.notEqual(producer.ownerId, verifier.ownerId);

    const [repro, negative] = collectProducingEvidence(vault, harness, producer);
    const finding = findingSchema.parse({
      schemaVersion: 1, findingId: 'finding-foreign-read', runId: harness.run.runId, taskId: producer.taskId,
      producerId: producer.ownerId, title: 'Foreign record read through the bounded fixture route', claim: CLAIM,
      classification: 'independently-observed', state: 'reproduced', evidenceIds: [repro], negativeControlEvidenceIds: [negative],
      limitations: ['bounded local fixture only; no production inference'],
    });
    assert.equal(finding.producerId, producer.ownerId);

    const broker = verifierBroker({ vault, staging, harness, verifierTask: verifierTaskRecord, verifierAttempt: verifier });
    const outcome = await replayFinding({
      vault, broker, finding, recipe: recipe(), replayId: 'replay-foreign-read',
      verifierId: verifier.ownerId, verifierTask: verifierTaskRecord, verifierAttempt: verifier,
      authorization: harness.run.authorization, clock: () => harness.clock.iso(), maxMs: 5_000,
    });
    assert.equal(outcome.status, 'accepted', JSON.stringify(outcome.issues));
    assert.equal(outcome.review.finding?.state, 'independently-validated');
    assert.equal(outcome.review.finding?.verifier?.identity, verifier.ownerId);
    assert.equal(outcome.review.finding?.verifier?.attemptId, verifier.attemptId);
    assert.notEqual(outcome.review.finding?.verifier?.identity, outcome.review.finding?.producerId);
    assert.equal(outcome.review.finding?.producerId, producer.ownerId);
    // Every replay observation was collected by the verifier attempt's own identity.
    for (const id of outcome.evidenceIds) {
      const receipt = vault.get(id);
      assert.ok(receipt, id);
      assert.equal(receipt.provenance.collectorId, verifier.ownerId, id);
      assert.equal(receipt.attemptId, verifier.attemptId, id);
    }
    assert.equal(vault.get('replay-foreign-read.baseline')!.provenance.collectorId, verifier.ownerId);

    // The producing identity can never verify its own finding, and a foreign attempt identity is refused.
    const crossIdentity = await replayFinding({
      vault, broker, finding, recipe: recipe(), replayId: 'replay-forged',
      verifierId: producer.ownerId, verifierTask: verifierTaskRecord, verifierAttempt: verifier,
      authorization: harness.run.authorization, clock: () => harness.clock.iso(), maxMs: 5_000,
    });
    assert.equal(crossIdentity.status, 'returned-for-evidence');
    assert.ok(crossIdentity.issues.some(issue => issue.code === 'verifier-identity'), JSON.stringify(crossIdentity.issues));
    assert.equal(vault.get('replay-forged.baseline'), undefined);
  } finally {
    vault.close();
    harness.supervisor.dispose();
    harness.store.close();
    rmSync(harness.root, { recursive: true, force: true });
  }
});
