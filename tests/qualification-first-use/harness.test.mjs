// Harness unit/driver contract tests ONLY. Not E2E or live-model qualification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerDialog, GITHUB_COMMIT, GITHUB_COMMIT_SUPERSEDED, CONSENT_LABEL } from './rpc.mjs';
import { planningAnswer, startInertProvider, workerAnswer } from './inert-provider.mjs';
import { redact, processIdentity, sha256 } from './observe.mjs';

const request = (method, title, extra = {}) => ({ type: 'extension_ui_request', id: 'real-wire-id', method, title, ...extra });

test('UI driver is labeled, exact-id correlated, and never approves an unknown prompt', () => {
  assert.equal(CONSENT_LABEL, 'automated-human-consent-simulation');
  assert.deepEqual(answerDialog(request('confirm', 'Make production changes?')), {
    type: 'extension_ui_response', id: 'real-wire-id', cancelled: true, reason: 'UNRECOGNIZED_CONFIRMATION',
  });
  assert.equal(answerDialog(request('confirm', 'First-use owner consent: confirm target and scope?'), { decline: 'First-use' }).confirmed, false);
  assert.equal(answerDialog(request('confirm', 'Approve plan fixed-plan?')).confirmed, true);
});

test('UI driver preserves denied script/state rights and refuses any live provider substitution', () => {
  const denied = 'No — keep repository scripts disabled';
  assert.equal(answerDialog(request('select', 'Read/static analysis is the default.', { options: [denied, 'Yes'] })).value, denied);
  assert.equal(answerDialog(request('select', 'Assessment model (parent agent selection is NOT consent)', {
    options: ['openai-codex-account-3/gpt-6.1-sol — BLOCKED unpriced', 'deepseek/deepseek-flash — priced'],
  })).cancelled, true);
  assert.equal(answerDialog(request('select', 'Assessment model', { options: ['inert-fixture/inert-worker — BLOCKED unpriced'] })).cancelled, true);
});

test('GitHub human consent simulation pins the exact full approved commit (negative stale-reuse)', () => {
  const title = 'Approve immutable source for the exact model plan?';
  assert.equal(answerDialog(request('confirm', title, { message: `Commit: ${GITHUB_COMMIT}` }), { kind: 'github' }).confirmed, true);
  assert.equal(answerDialog(request('confirm', title, { message: `Commit: ${GITHUB_COMMIT_SUPERSEDED}` }), { kind: 'github' }).confirmed, false);
  assert.equal(answerDialog(request('confirm', title, { message: `Commit: ${GITHUB_COMMIT_SUPERSEDED}` }), { kind: 'github' }).reason, 'PINNED_GITHUB_COMMIT_MISMATCH');
  assert.equal(answerDialog(request('confirm', title, { message: `Commit: ${'0'.repeat(40)}` }), { kind: 'github' }).confirmed, false);
  assert.equal(answerDialog(request('confirm', title, { message: 'No revision' }), { kind: 'github' }).reason, 'PINNED_GITHUB_COMMIT_MISMATCH');
});

test('inert planner can only select the real supplied menu or the exact owned loopback URL', () => {
  const input = { runId: 'r', scopeDigest: 'd', facts: { targetKind: 'local-dir', locator: '/owned', ownerObservations: [{ taskId: 'assessment', observationId: 'static-source-inventory' }] } };
  const menu = planningAnswer([{ role: 'user', content: `Facts:\n${JSON.stringify(input)}` }]);
  assert.deepEqual(menu.ownerMenu, [{ taskId: 'assessment', observationId: 'static-source-inventory' }]);
  input.facts = { targetKind: 'http-url', locator: 'http://127.0.0.1:1234/exact', generatedTasks: [{ taskId: 'assessment' }] };
  assert.equal(planningAnswer([{ role: 'user', content: JSON.stringify(input) }]).generatedRequests.requests[0].url, input.facts.locator);
  input.facts.locator = 'https://example.com/';
  assert.throws(() => planningAnswer([{ role: 'user', content: JSON.stringify(input) }]), /INERT_SCOPE_DENIED/);
});

test('inert gateway really binds loopback and refuses unknown model ids before any response script', async () => {
  const provider = await startInertProvider();
  try {
    assert.match(provider.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${provider.origin}/chat/completions`, {
      method: 'POST', body: JSON.stringify({ model: 'paid-model', messages: [] }),
    });
    assert.equal(response.status, 400); assert.match(await response.text(), /INERT_MODEL_DENIED/);
    assert.equal(provider.receipts.length, 0);
    const other = await fetch(`${provider.origin}/unknown`); assert.equal(other.status, 404);
  } finally { await provider.close(); }
});

test('real kernel identity is not reduced to PID-only and persisted credentials are redacted', () => {
  const own = processIdentity(process.pid);
  assert.equal(own.pid, process.pid); assert.match(own.startTicks, /^\d+$/); assert(own.bootId.length > 0);
  assert.deepEqual(redact({ owner: { token: 'private' }, apiKey: 'private', digest: 'public' }), {
    owner: { token: '[REDACTED]' }, apiKey: '[REDACTED]', digest: 'public',
  });
  assert.equal(sha256('Hello World!\n'), '03ba204e50d126e4674c005e04d82e84c21366780af1f43bd54a37816b6ab340');
});

test('worker script never fabricates a context or collector evidence id', () => {
  assert.equal(workerAnswer({ messages: [] }).tool.name, 'p2o_context');
  const context = { observedRuntime: { attestation: 'attested' }, observations: [], allowedActions: ['read'] };
  const messages = [{ role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'p2o_context', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: JSON.stringify(context) }];
  assert.throws(() => workerAnswer({ messages }), /real broker returned no evidence ids/);
});
