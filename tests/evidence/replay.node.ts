import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { attemptSchema, digestJson, taskSchema, type AttemptRecord, type Authorization, type JsonObject, type TaskManifest } from '../../src/contracts/index.js';
import {
  replayFinding, sha256, type CleanReplayBroker, type CleanReplaySession, type LocalReplayRecipe, type ReplayRequest,
} from '../../src/evidence/index.js';
import type { ToolReceipt, ToolResult } from '../../src/tools/types.js';
import { attemptFixture, taskFixture } from '../contracts/fixtures.js';
import { CLAIM, CONFIG, collectStaticPropertyEvidence, createHarness, findingFixture, INPUT, NOW, type Harness } from './fixtures.js';
import { scopedReplayPolicyFixture } from './scoped-fixtures.js';

// PURE fixed response fixtures: no network, reset, sandbox or live-assessment qualification.
const BROKER = sha256('inert-flip-fixture-broker-v1');
type Mode = 'vulnerable' | 'patched' | 'noisy' | 'control-fails';
interface Fixture { mode: Mode; requests: string[] }

function respond(fixture: Fixture, pathname: string): { status: number; body: Record<string, unknown> } {
  fixture.requests.push(pathname);
  if (pathname === '/own') return { status: 200, body: { marker: 'own', ok: true } };
  if (pathname === '/control-foreign') return fixture.mode === 'control-fails' ? { status: 200, body: { marker: 'unexpected' } } : { status: 403, body: { marker: 'denied' } };
  if (pathname === '/foreign') {
    if (fixture.mode === 'patched') return { status: 403, body: { marker: 'denied' } };
    if (fixture.mode === 'noisy') return { status: 200, body: { note: 'no marker' } };
    return { status: 200, body: { marker: 'foreign-marker' } };
  }
  return { status: 404, body: { marker: 'missing' } };
}
interface Verifier { authorization: Authorization; task: TaskManifest; attempt: AttemptRecord }
function verifierFixture(h: Harness, base: string): Verifier {
  const authorization: Authorization = {
    reference: 'owner-approved-local-fixture', authorizedBy: 'fixture-owner', validFrom: h.run.authorization.validFrom, expiresAt: h.run.authorization.expiresAt,
    targets: [{ id: 'fixture-lab', kind: 'lab', locator: `http://127.0.0.1:${base}/` }], exclusions: [], allowedActions: ['read', 'review', 'local-test'],
  };
  const task = taskSchema.parse({ ...taskFixture('task-verifier', join(h.worker, 'verifier')), taskId: 'task-verifier', workspace: join(h.worker, 'verifier'),
    question: { text: 'Does the bounded local fixture reproduce the claimed foreign read?', ifTrue: 'the violation observable appears', ifFalse: 'only the original-policy denial appears' },
    scope: { authorizationRef: authorization.reference, targetIds: ['fixture-lab'], actor: { id: 'verifier-actor', privileges: ['read-only'] }, boundary: 'authorized local fixture only', isolation: 'inert local lab', recovery: 'discard replay outputs', environmentId: 'lab-2', configurationDigest: CONFIG, inputs: [{ id: 'fixture', digest: INPUT, locator: 'fixtures/input.ts', revision: 'r1' }] },
    allowedActions: ['read'], requestedRuntime: h.task.requestedRuntime, lifecycleState: 'running' });
  const attempt = attemptSchema.parse({ ...attemptFixture(), attemptId: 'attempt-verifier', taskId: task.taskId, ownerId: 'verifier-9', leaseToken: 'verifier-fencing-token', requestedRuntime: task.requestedRuntime });
  return { authorization, task, attempt };
}
function recipe(base: string, mutate: (r: LocalReplayRecipe) => void = () => {}): LocalReplayRecipe {
  const url = (path: string) => `http://127.0.0.1:${base}${path}`;
  const value: LocalReplayRecipe = { recipeId: 'recipe-1', fixtureId: 'fixture', targetId: 'fixture-lab', invariant: CLAIM, inputDigests: [INPUT],
    baseline: { input: { url: url('/own'), accountId: 'local-reader' }, expected: { status: 200, bodyIncludes: 'own' } },
    negativeControl: { input: { url: url('/control-foreign'), accountId: 'local-reader' }, expected: { status: 403, bodyIncludes: 'denied' } },
    probe: { input: { url: url('/foreign'), accountId: 'local-reader' }, violation: { status: 200, bodyIncludes: 'foreign-marker' }, safe: { status: 403, bodyIncludes: 'denied' } } };
  mutate(value); return value;
}
interface FakeOptions { fixture: Fixture; environmentId?: string; terminationConfirmed?: boolean; prepareHang?: boolean; receiptGrantId?: string;
  environmentMetadata?: JsonObject; omitPolicy?: boolean }
function fakeBroker(h: Harness, verifier: Verifier, options: FakeOptions): CleanReplayBroker {
  const approvedRecipe = recipe('8123');
  const { policy, context } = scopedReplayPolicyFixture({ run: h.run, task: verifier.task, attempt: verifier.attempt,
    targetId: 'fixture-lab', accountId: 'local-reader', grantId: 'verifier-grant-1', now: () => Date.parse(NOW) });
  const scopeDigest = policy.scopeDigest;
  let ordinal = 0;
  const admitRuntime = (id: string, patches: JsonObject, content: string): string => {
    const handle = h.vault.issueCollector(h.grant({ collectorId: 'verifier-9', role: 'verifier', taskId: verifier.task.taskId, attemptId: verifier.attempt.attemptId,
      environmentId: patches.environmentId as string ?? verifier.task.scope.environmentId, configurationDigest: verifier.task.scope.configurationDigest, scopeDigest,
      inputDigests: [INPUT], toolGrantId: 'verifier-grant-1', tool: { name: 'http.request', version: '1.0.0', implementationDigest: BROKER }, allowedKinds: ['runtime'], allowedClassifications: ['independently-observed'] }));
    return h.vault.admit(handle, h.submission(id, 'runtime', { metadata: patches, collectedAt: NOW }, content)).receipt.evidenceId;
  };
  const environmentReceiptId = admitRuntime('verifier-environment', { independentSession: true, targetReset: false, recipeDigest: digestJson(approvedRecipe),
    qualification: 'inert independent verifier session; target not reset', environmentId: options.environmentId ?? 'lab-2', ...options.environmentMetadata },
    JSON.stringify({ independentSession: true, targetReset: false, qualification: 'pure fixed response fixture, no target reset' }));
  return {
    async prepare(request: ReplayRequest): Promise<CleanReplaySession> {
      if (options.prepareHang) return new Promise<CleanReplaySession>(() => {});
      assert.equal(request.authorization.reference, verifier.authorization.reference);
      assert.equal(request.recipeDigest, digestJson(approvedRecipe), 'session must qualify the exact controller-approved recipe');
      return {
        ...(options.omitPolicy ? {} : { verificationPolicy: policy }),
        environmentReceiptId, context: { runId: request.task.runId, taskId: request.task.taskId, attemptId: request.attempt.attemptId, grantId: 'verifier-grant-1' },
        artifactRootId: 'staging', httpTool: { name: 'http.request', version: '1.0.0', implementationDigest: BROKER },
        broker: {
          async execute({ context: executionContext, input }): Promise<ToolResult> {
            const operation = input as { url: string; accountId: string };
            assert.deepEqual(executionContext, context);
            policy.assertRequest(executionContext, 'fixture-lab', operation);
            const { status, body } = respond(options.fixture, new URL(operation.url).pathname);
            const data = { kind: 'http', status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
            const content = JSON.stringify(data), path = `${request.replayId}-${ordinal++}.json`;
            writeFileSync(join(h.staging, path), content, { mode: 0o600 });
            const artifact = { path, sha256: sha256(content), bytes: Buffer.byteLength(content), mediaType: 'application/json' as const, redacted: true as const };
            const receipt: ToolReceipt = { version: 1, context: { runId: request.task.runId, taskId: request.task.taskId, attemptId: request.attempt.attemptId, grantId: options.receiptGrantId ?? 'verifier-grant-1' },
              tool: { id: 'http.request', version: '1.0.0', implementationDigest: BROKER }, scopeDigest, configurationDigest: verifier.task.scope.configurationDigest,
              inputDigest: digestJson(operation), startedAt: NOW, finishedAt: NOW, outcome: 'collected', targets: ['fixture-lab'], budgets: { 'fixture-lab': { requests: ordinal, bytes: artifact.bytes, active: 0, windowRequests: ordinal } },
              artifacts: [artifact], isolation: 'inert-in-process-fixture-not-a-sandbox', classification: 'observation-not-verified-finding' };
            return { data, artifact, receipt };
          },
        },
        async close() { return { receiptEvidenceId: admitRuntime('verifier-termination', { terminationConfirmed: options.terminationConfirmed ?? true, environmentId: options.environmentId ?? 'lab-2' }, JSON.stringify({ terminated: true })) }; },
      };
    },
  };
}
function setup(mode: Mode, options: Partial<FakeOptions> = {}, recipePatch: (r: LocalReplayRecipe) => void = () => {}) {
  const h = createHarness();
  const fixture: Fixture = { mode, requests: [] };
  const verifier = verifierFixture(h, '8123');
  h.run.authorization = verifier.authorization;
  h.run.allowedCapabilities = ['http.request'];
  h.run.budgets.targetRequestLimits = { 'fixture-lab': 3 };
  h.collect('repro', 'reproduction');
  h.collect('negative', 'negative-control');
  const finding = findingFixture(h, 'reproduced');
  const broker = fakeBroker(h, verifier, { fixture, ...options });
  return { h, fixture, verifier, finding, broker, options: { vault: h.vault, finding, recipe: recipe('8123', recipePatch), replayId: 'replay-1', verifierId: 'verifier-9', verifierTask: verifier.task, verifierAttempt: verifier.attempt, authorization: verifier.authorization, clock: () => NOW, broker } };
}
test('independent replay of the authorized local fixture validates the claim', async () => {
  const s = setup('vulnerable');
  try {
    const outcome = await replayFinding(s.options);
    assert.equal(outcome.status, 'accepted', JSON.stringify(outcome.issues));
    assert.equal(outcome.review.finding!.state, 'independently-validated');
    assert.equal(outcome.review.finding!.verifier!.identity, 'verifier-9');
    assert.equal(outcome.review.finding!.verifier!.evidenceIds.includes('verifier-termination'), true);
    assert.deepEqual(s.fixture.requests, ['/own', '/control-foreign', '/foreign']);
    const baseline = s.h.vault.get(`${s.options.replayId}.baseline`)!;
    assert.equal(baseline.test!.successes, 1);
    assert.equal(baseline.provenance.collectorId, 'verifier-9');
    const session = s.h.vault.get('verifier-environment')!;
    assert.equal(session.metadata?.independentSession, true);
    assert.equal(session.metadata?.targetReset, false);
    assert.equal(session.metadata?.cleanEnvironment, undefined, 'a fresh verifier attempt must not be described as a clean target reset');
    assert.equal(session.metadata?.recipeDigest, digestJson(s.options.recipe));
  } finally { s.h.dispose(); }
});
test('a safe fixture result rejects the claim instead of hiding it', async () => {
  const s = setup('patched');
  try {
    const outcome = await replayFinding(s.options);
    assert.equal(outcome.status, 'rejected');
    assert.equal(outcome.review.finding!.state, 'rejected');
    assert.equal(outcome.review.finding!.limitations.some(l => l.includes('did not reproduce')), true);
  } finally { s.h.dispose(); }
});
test('an inconclusive probe stays unresolved, not validated', async () => {
  const s = setup('noisy');
  try {
    const outcome = await replayFinding(s.options);
    assert.equal(outcome.status, 'returned-for-evidence');
    assert.equal(outcome.review.finding!.state, 'unresolved');
    assert.ok(outcome.issues.some(i => i.code === 'replay-inconclusive'));
  } finally { s.h.dispose(); }
});
test('a failed negative control blocks acceptance and is preserved', async () => {
  const s = setup('control-fails');
  try {
    const outcome = await replayFinding(s.options);
    assert.equal(outcome.status, 'returned-for-evidence');
    assert.ok(outcome.issues.some(i => i.code === 'replay-controls'));
    const control = s.h.vault.get(`${s.options.replayId}.negative-control`)!;
    assert.equal(control.test!.outcome, 'failed');
    assert.equal(control.test!.successes, 0);
  } finally { s.h.dispose(); }
});
test('unapproved destinations (including external-shaped hosts) and widened inputs are refused before any execution', async () => {
  const external = setup('vulnerable', {}, r => { r.probe.input.url = 'https://example.com/foreign'; });
  try {
    const outcome = await replayFinding(external.options);
    assert.equal(outcome.status, 'returned-for-evidence');
    assert.equal(external.fixture.requests.length, 0);
    assert.ok(outcome.issues.some(i => i.code === 'scoped-target'), JSON.stringify(outcome.issues));
  } finally { external.h.dispose(); }
  const drifted = setup('vulnerable', {}, r => { r.inputDigests = ['d'.repeat(64)]; });
  try {
    const outcome = await replayFinding(drifted.options);
    assert.equal(outcome.status, 'returned-for-evidence');
    assert.equal(drifted.fixture.requests.length, 0);
    assert.ok(outcome.issues.some(i => i.code === 'replay-input'));
  } finally { drifted.h.dispose(); }
});
test('worker-authored execution fields are rejected: replay has no script/command interface', async () => {
  const scripted = setup('vulnerable', {}, r => { Object.assign(r.probe.input, { body: 'rm -rf /', headers: { authorization: 'Bearer x' }, method: 'POST', command: 'curl https://example.com' }); });
  try {
    const outcome = await replayFinding(scripted.options);
    assert.equal(outcome.status, 'returned-for-evidence');
    assert.equal(scripted.fixture.requests.length, 0);
    assert.ok(outcome.issues.length > 0);
  } finally { scripted.h.dispose(); }
});
test('an unqualified or replicated clean environment is refused', async () => {
  const sandboxed = setup('vulnerable', { environmentId: 'lab-1' });
  try {
    const outcome = await replayFinding(sandboxed.options);
    assert.equal(outcome.status, 'returned-for-evidence');
    assert.equal(sandboxed.fixture.requests.length, 0);
    assert.ok(outcome.issues.some(i => i.code === 'clean-environment'), JSON.stringify(outcome.issues));
  } finally { sandboxed.h.dispose(); }
});
test('unconfirmed environment termination is never reported as independent validation', async () => {
  const s = setup('vulnerable', { terminationConfirmed: false });
  try {
    const outcome = await replayFinding(s.options);
    assert.equal(outcome.status, 'returned-for-evidence');
    assert.ok(outcome.issues.some(i => i.code === 'replay-cleanup'));
    assert.equal(outcome.review.finding!.state, 'unresolved');
  } finally { s.h.dispose(); }
});
test('a hung replay preparation is bounded and reported as blocked', async () => {
  const s = setup('vulnerable', { prepareHang: true });
  try {
    const outcome = await replayFinding({ ...s.options, maxMs: 60 });
    assert.equal(outcome.status, 'returned-for-evidence');
    assert.ok(outcome.issues.some(i => i.code === 'replay-blocked'));
    assert.equal(s.fixture.requests.length, 0);
  } finally { s.h.dispose(); }
});
test('static-only findings are retained without any replay execution', async () => {
  const s = setup('vulnerable');
  try {
    collectStaticPropertyEvidence(s.h);
    const outcome = await replayFinding({ ...s.options, finding: findingFixture(s.h, 'supported-static') });
    assert.equal(outcome.status, 'accepted');
    assert.equal(outcome.review.finding!.state, 'supported-static');
    assert.equal(s.fixture.requests.length, 0);
    assert.ok(outcome.issues.some(i => i.code === 'static-only'));
  } finally { s.h.dispose(); }
});
test('a broker grant identity that does not match the verifier collector is blocked', async () => {
  const s = setup('vulnerable', { receiptGrantId: 'other-grant-9' });
  try {
    const outcome = await replayFinding(s.options);
    assert.equal(outcome.status, 'returned-for-evidence');
    assert.ok(outcome.issues.some(i => i.code === 'broker-identity'), JSON.stringify(outcome.issues));
  } finally { s.h.dispose(); }
});
test('a distinct verifier attempt/session does not qualify a claimed target reset', async () => {
  const s = setup('vulnerable', { environmentMetadata: { targetReset: true, cleanEnvironment: true, qualification: 'fresh attempt asserted as a reset, without reconstruction proof' } });
  try {
    const outcome = await replayFinding(s.options);
    assert.equal(outcome.status, 'returned-for-evidence');
    assert.equal(outcome.review.finding!.state, 'unresolved');
    assert.ok(outcome.issues.some(i => i.code === 'clean-environment'));
    assert.equal(s.fixture.requests.length, 0, 'no request may run on an unqualified reset claim');
  } finally { s.h.dispose(); }
});
test('independent-session receipts without an issued scoped capability cannot authorize replay', async () => {
  const s = setup('vulnerable', { omitPolicy: true });
  try {
    const outcome = await replayFinding(s.options);
    assert.equal(outcome.status, 'returned-for-evidence');
    assert.equal(outcome.review.finding!.state, 'unresolved');
    assert.ok(outcome.issues.some(i => i.code === 'verification-policy'));
    assert.equal(s.fixture.requests.length, 0);
  } finally { s.h.dispose(); }
});
test('predictions changed after controller recipe approval cannot drive replay', async () => {
  const s = setup('vulnerable', {}, value => { value.probe.violation.bodyIncludes = 'invented-marker'; });
  try {
    const outcome = await replayFinding(s.options);
    assert.equal(outcome.status, 'returned-for-evidence');
    assert.equal(outcome.review.finding!.state, 'unresolved');
    assert.ok(outcome.issues.some(i => i.message.includes('exact controller-approved recipe')));
    assert.equal(s.fixture.requests.length, 0);
  } finally { s.h.dispose(); }
});
