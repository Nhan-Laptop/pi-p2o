// R1 regression at the evidence boundary: the sandbox configuration digest attests the owner-approved
// sandbox configuration, never run-scoped lifecycle bookkeeping, so a broker receipt produced by a sandbox
// created with a controller lifecycle is admissible against the owner-approved scope digest. The negative
// control proves a genuinely different configuration is still refused (`broker-input`).
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { digestJson } from '../../src/contracts/index.js';
import { admitToolResult } from '../../src/evidence/broker.js';
import { sha256 } from '../../src/evidence/index.js';
import { createContainerSandbox, type ContainerSandboxOptions } from '../../src/tools/index.js';
import { createHarness } from './fixtures.js';

const CAPABILITY = 'source.analyze' as const;
const IMPLEMENTATION = sha256('r1-fixed-inert-tool-implementation');
const SCOPE = Object.freeze({ runId: 'run-lifecycle-digest', taskId: 'task-lifecycle-digest', attemptId: 'attempt-lifecycle-digest' });
const lifecycle = { check: async () => undefined, enroll: async () => undefined, update: async () => undefined, resolve: async () => undefined };

function sandboxOptions(root: string, overrides: Partial<ContainerSandboxOptions> = {}): ContainerSandboxOptions {
  const inputRoot = join(root, 'inputs'), outputRoot = join(root, 'outputs');
  for (const path of [inputRoot, outputRoot]) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
  return {
    inputRoot, outputRoot, trustedInputSnapshot: true,
    enginePath: '/usr/bin/docker', engineVersion: '28.5.2+dfsg4',
    image: `sha256:${'a'.repeat(64)}`, imageRootfsLayers: [`sha256:${'1'.repeat(64)}`], baseImageId: `sha256:${'2'.repeat(64)}`,
    workerSha256: 'b'.repeat(64), sourceSha256: 'c'.repeat(64),
    seccompPath: join(root, 'seccomp.json'), seccompSha256: 'd'.repeat(64),
    qualification: { acknowledgement: 'containers-share-host-kernel-not-hostile-code-isolation', dedicatedLab: true, approvedBy: 'r1-fixture-owner', expiresAt: '2099-01-01T00:00:00.000Z', nativeEnabled: false },
    ...overrides,
  };
}

test('a receipt from a controller-lifecycle sandbox is admissible against the owner-approved scope digest', () => {
  const h = createHarness();
  const root = mkdtempSync(join(tmpdir(), 'p2o-r1-digest-'));
  try {
    const options = sandboxOptions(root);
    const approved = createContainerSandbox(options).configurationDigest;
    const runtime = createContainerSandbox({ ...options, controllerLifecycle: { scope: SCOPE, lifecycle } }).configurationDigest;
    const attemptScoped = createContainerSandbox({ ...options, lifecycle: { scope: SCOPE, lifecycle } }).configurationDigest;
    // R1: the lifecycle binding is runtime bookkeeping, not owner-approved configuration.
    assert.equal(runtime, approved, 'controller lifecycle must not change the configuration digest');
    assert.equal(attemptScoped, approved, 'attempt lifecycle must not change the configuration digest');

    // A faithful broker receipt/artifact pair whose sandbox carried the controller lifecycle.
    const data = { kind: 'observation', note: 'inert local R1 fixture', value: 1 };
    const bytes = JSON.stringify(data);
    const path = 'r1-tool-artifact.json';
    writeFileSync(join(h.staging, path), bytes, { mode: 0o600 });
    const artifact = { path, sha256: sha256(bytes), bytes: Buffer.byteLength(bytes), mediaType: 'application/json' as const, redacted: true as const };
    const operationInput = { paths: ['fixture.ts'] };
    const now = h.task.createdAt;
    const receipt = {
      version: 1 as const,
      context: { runId: h.run.runId, taskId: h.task.taskId, attemptId: h.attempt.attemptId, grantId: 'fixture-grant-1' },
      tool: { id: CAPABILITY, version: '1.0.0', implementationDigest: IMPLEMENTATION },
      scopeDigest: sha256('explicit-fixture-policy'), configurationDigest: runtime, inputDigest: digestJson(operationInput),
      startedAt: now, finishedAt: now,
      outcome: 'collected' as const, targets: [], budgets: {}, artifacts: [artifact],
      isolation: 'dedicated-offline-container:shared-kernel:broker-only-target-egress', classification: 'observation-not-verified-finding' as const,
    };
    const handle = h.vault.issueCollector(h.grant({
      collectorId: 'p2o-collector', role: 'collector', configurationDigest: approved,
      tool: { name: CAPABILITY, version: '1.0.0', implementationDigest: IMPLEMENTATION }, toolGrantId: 'fixture-grant-1',
      artifactRootIds: ['staging'], allowedKinds: ['observation'], allowedClassifications: ['independently-observed'],
    }));
    const admitted = admitToolResult(h.vault, handle, {
      result: { data, artifact, receipt },
      operationInput, artifactRootId: 'staging',
      evidence: { evidenceId: 'r1-observation', idempotencyKey: 'r1-observation', kind: 'observation' as const, classification: 'independently-observed' as const, summary: 'Inert R1 digest-boundary fixture' },
    });
    assert.equal(admitted.receipt.evidenceId, 'r1-observation');
    assert.equal(admitted.receipt.provenance.configurationDigest, approved, 'admission binds the owner-approved configuration digest');

    // Negative control: a genuinely different configuration (different image pin) is still refused.
    const otherConfiguration = createContainerSandbox({ ...options, image: `sha256:${'e'.repeat(64)}` }).configurationDigest;
    const otherHandle = h.vault.issueCollector(h.grant({
      collectorId: 'p2o-collector', role: 'collector', configurationDigest: otherConfiguration,
      tool: { name: CAPABILITY, version: '1.0.0', implementationDigest: IMPLEMENTATION }, toolGrantId: 'fixture-grant-1',
      artifactRootIds: ['staging'], allowedKinds: ['observation'], allowedClassifications: ['independently-observed'],
    }));
    assert.throws(() => admitToolResult(h.vault, otherHandle, {
      result: { data, artifact, receipt },
      operationInput, artifactRootId: 'staging',
      evidence: { evidenceId: 'r1-observation-other', idempotencyKey: 'r1-observation-other', kind: 'observation' as const, classification: 'independently-observed' as const, summary: 'Inert R1 digest-boundary fixture' },
    }), (error: unknown) => error instanceof Error && error.message.includes('broker-input'));
  } finally {
    h.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
