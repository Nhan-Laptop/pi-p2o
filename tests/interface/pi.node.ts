import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import p2oExtension, { registerP2O } from '../../extensions/p2o/index.js';
import { schemas, validate } from '../../src/interface/schemas.js';
import { boundedOutput, projectEvents, publicValue } from '../../src/interface/presentation.js';
import { deferred, FakeBackend, fakePi, input, requested } from './helpers.js';

function setup(hasUI = true) {
  const pi = fakePi(hasUI), backend = new FakeBackend();
  let factories = 0;
  const controller = registerP2O(pi.api, { backendFactory: () => { factories++; return backend; } });
  return { pi, backend, controller, factories: () => factories };
}

test('all prefixed Pi tools/commands register against the real public API shapes without startup resources', async () => {
  const s = setup();
  // Fourteen existing control actions plus the session-bound foreground orchestrator.
  assert.equal(s.pi.tools.size, 15);
  assert.deepEqual([...s.pi.tools.keys()], Object.keys(schemas).map(k => `p2o_${k}`));
  // Exactly one human slash command (`/p2o`); the per-action command registrations are gone.
  assert.deepEqual([...s.pi.commands.keys()], ['p2o']);
  assert.ok([...s.pi.commands.keys()].every(name => !name.startsWith('p2o_')));
  for (const [name, tool] of s.pi.tools) {
    assert.equal((tool.parameters as { additionalProperties?: boolean }).additionalProperties, false);
    assert.ok(tool.promptGuidelines?.every(g => g.includes(name)));
    assert.match(tool.description, /48KiB/);
    assert.match(tool.promptGuidelines![0], /does not establish authorization/);
  }
  await s.pi.event('session_start');
  assert.match(s.pi.statuses[0].text!, /parent\/parent-model\/max.*not worker attestation/);
  assert.equal(s.factories(), 0);
  await s.pi.event('session_shutdown');
  assert.equal(s.factories(), 0);
});

test('owner-gated control tools dispatch to the port and fail closed when the composition does not expose them', async () => {
  const s = setup();
  const switchSelection = { provider: 'fixture-provider', model: 'fixture-model', thinking: 'max' as const };
  const switchInput = { attemptId: 'attempt-1', selection: switchSelection, reason: 'owner-approved switch rehearsal' };
  const subtaskInput = { attemptId: 'attempt-1', question: { text: 'q', ifTrue: 'yes', ifFalse: 'no' }, targetIds: ['lab-fixture-a'], actor: { id: 'guest', privileges: ['read'] }, inputRevision: 'r1', role: 'worker', reason: 'narrowed follow-up' };
  // A composition that does not expose the owner-gated action fails closed instead of inventing one.
  await assert.rejects(s.pi.call('p2o_switch_model', switchInput), /INTEGRATION_REQUIRED/);
  await assert.rejects(s.pi.call('p2o_subtask', subtaskInput), /INTEGRATION_REQUIRED/);
  assert.deepEqual(validate('switch_model', switchInput), switchInput);
  assert.deepEqual(validate('subtask', subtaskInput), subtaskInput);
  for (const invalid of [
    { ...switchInput, selection: { ...switchSelection, thinking: 'extreme' } },
    { ...switchInput, reason: '' },
    { ...subtaskInput, role: 'orchestrator' },
    { ...subtaskInput, targetIds: [] },
    { ...subtaskInput, actor: { id: 'guest', privileges: [] } },
    { ...subtaskInput, extra: true },
  ]) {
    const action = 'attemptId' in invalid && 'reason' in invalid && 'selection' in invalid ? 'switch_model' : 'subtask';
    assert.throws(() => validate(action, invalid), /INVALID_INPUT/);
  }
  // When the port exposes them, the controller forwards the validated request unchanged.
  s.backend.switchModel = async (input) => { s.backend.calls.push('switch_model'); return { switchId: 'switch-1', input }; };
  s.backend.requestSubtask = async (input) => { s.backend.calls.push('subtask'); return { decisionId: 'subtask-1', input }; };
  const switched = (await s.pi.call('p2o_switch_model', switchInput)).details as { switchId: string };
  const admitted = (await s.pi.call('p2o_subtask', subtaskInput)).details as { decisionId: string };
  assert.equal(switched.switchId, 'switch-1');
  assert.equal(admitted.decisionId, 'subtask-1');
  assert.deepEqual(s.backend.calls.filter(c => c === 'switch_model' || c === 'subtask'), ['switch_model', 'subtask']);
  await s.pi.event('session_shutdown');
});

test('strict schema validation runs even with fake API/direct execute and command mutations', async () => {
  const s = setup();
  const invalid = [
    {}, { ...input, mode: undefined }, { ...input, mode: 'scan' }, { ...input, force: true },
    { ...input, runtime: 'plan' }, { ...input, selection: { ...requested, apiKey: 'SECRET' } },
    { ...input, selection: { ...requested, thinking: 'extreme' } }, { ...input, manifestPath: 'bad\x00file' },
    { ...input, selection: { ...requested, model: '--api-key=SECRET' } },
  ];
  for (const args of invalid) await assert.rejects(s.pi.call('p2o_start', args), /INVALID_INPUT/);
  const accessor = Object.defineProperty({ ...input }, 'mode', { get() { throw new Error('getter must not run'); } });
  await assert.rejects(s.pi.call('p2o_start', accessor), /accessors/);
  await assert.rejects(s.pi.call('p2o_status', JSON.parse('{"runId":"run-1","__proto__":{"x":1}}')), /unsafe/);
  await assert.rejects(s.pi.call('p2o_tasks', { runId: 'run-1', limit: 101 }), /INVALID_INPUT/);
  await s.pi.command('p2o', '--scope approved.json');
  assert.equal(s.pi.messages.at(-1)?.customType, 'p2o_error');
  assert.match(String(s.pi.messages.at(-1)?.content), /UNKNOWN_FLAG/);
  await s.pi.command('p2o', '--target approved.json --depth wide');
  assert.match(String(s.pi.messages.at(-1)?.content), /INVALID_DEPTH/);
  assert.equal(s.factories(), 0);
  await s.controller.close();
});

test('scope preflight blocks start and resume; passing preflight is not reusable dispatch permission', async () => {
  const s = setup();
  s.backend.ready = false;
  await assert.rejects(s.pi.call('p2o_start', input), /PREFLIGHT_BLOCKED.*SCOPE_EXPIRED/);
  await assert.rejects(s.pi.call('p2o_resume', { ...input, runId: 'run-1' }), /PREFLIGHT_BLOCKED/);
  assert.ok(!s.backend.calls.includes('start') && !s.backend.calls.includes('resume'));
  s.backend.ready = true;
  s.backend.dispatchAllowed = false;
  await assert.rejects(s.pi.call('p2o_start', input), error => {
    assert.match((error as Error).message, /SCOPE_EXPIRED/);
    assert.ok(!(error as Error).message.includes('DO_NOT_EXPOSE'));
    return true;
  });
  await s.controller.close();
});

test('configured selection is a request; launch returns no fabricated observations or acceptance', async () => {
  const s = setup();
  const result = await s.pi.call('p2o_start', { ...input, runtime: 'herdr' });
  const details = result.details as Record<string, unknown>;
  assert.deepEqual(details.requested, { adapter: 'herdr', selection: requested });
  assert.equal(details.resultAcceptance, 'not-evaluated');
  assert.equal((details.observed as { attestation: string }).attestation, 'unavailable');
  const status = await s.pi.call('p2o_status', { runId: 'run-1' });
  const text = status.content[0] as { text: string };
  assert.match(text.text, /requested-provider/);
  assert.match(text.text, /observed-provider/);
  assert.match(text.text, /returned-for-evidence/);
  assert.match(text.text, /unresolved/);
  assert.match(text.text, /untested/);
  assert.match(text.text, /WORKER_FAILED/);
  assert.ok(!JSON.stringify(status).includes('DO_NOT_EXPOSE'));
  assert.ok(!JSON.stringify(status).includes('/private/'));
  await s.controller.close();
  assert.ok(s.backend.calls.includes('stop:run-1'));
});

test('metadata/report/events access is projected, paginated and throws errors rather than fake success', async () => {
  const s = setup(false);
  for (const action of ['tasks', 'evidence', 'report', 'events']) {
    const result = await s.pi.call(`p2o_${action}`, { runId: 'run-1' });
    assert.ok(!JSON.stringify(result).includes('DO_NOT_EXPOSE'));
    assert.ok(!JSON.stringify(result).includes('/private/'));
  }
  const markdown = await s.pi.call('p2o_report', { runId: 'run-1', format: 'markdown' });
  assert.match(JSON.stringify(markdown), /Qualified report/);
  await assert.rejects(s.pi.call('p2o_status', { runId: 'absent' }), /NOT_FOUND/);
  await s.pi.command('p2o', 'status run-1');
  assert.equal(s.pi.messages.at(-1)?.customType, 'p2o_result');
  await s.controller.close();
});

test('preflight/doctor are real reads, use the dedicated doctor port when present, and never launch', async () => {
  const s = setup();
  s.backend.ready = false;
  for (const tool of ['p2o_preflight', 'p2o_doctor']) {
    const result = await s.pi.call(tool, input);
    assert.equal((result.details as { ok: boolean }).ok, false);
  }
  assert.deepEqual(s.backend.calls, ['preflight', 'doctor']);
  const doctor = await s.pi.call('p2o_doctor', input);
  assert.match(JSON.stringify(doctor), /vault-backed report renderer is wired/);
  assert.ok(!s.backend.calls.includes('start'));
  await s.controller.close();
});

test('stop reaches runtime ownership even with an aborted parent signal and surfaces uncertain termination', async () => {
  const s = setup(), abort = new AbortController();
  abort.abort();
  const result = await s.pi.call('p2o_stop', { runId: 'run-1' }, abort.signal);
  assert.equal((result.details as { terminationVerified: boolean }).terminationVerified, true);
  s.backend.verifiedStop = false;
  await assert.rejects(s.pi.call('p2o_stop', { runId: 'run-1' }), /STOP_UNVERIFIED/);
  await s.controller.close();
});

test('already-cancelled start acquires no backend and cancellation during preflight prevents dispatch', async () => {
  const s = setup(), abort = new AbortController();
  abort.abort();
  await assert.rejects(s.pi.call('p2o_start', input, abort.signal), /CANCELLED/);
  assert.equal(s.factories(), 0);
  const gate = deferred();
  const original = s.backend.preflight.bind(s.backend);
  s.backend.preflight = async p => { await gate.promise; return original(p); };
  const a = new AbortController();
  const work = s.pi.call('p2o_start', input, a.signal);
  await nextTurn(); a.abort(); gate.resolve();
  await assert.rejects(work, /CANCELLED/);
  assert.ok(!s.backend.calls.includes('start'));
  await s.controller.close();
});

test('late launch after cancellation is stopped and verified before returning an error', async () => {
  const s = setup(), gate = deferred(), abort = new AbortController();
  s.backend.startWait = () => gate.promise;
  const work = s.pi.call('p2o_start', input, abort.signal);
  await nextTurn();
  assert.ok(s.backend.calls.includes('start'));
  abort.abort(); gate.resolve();
  await assert.rejects(work, /CANCELLED/);
  assert.ok(s.backend.calls.includes('stop:run-1'));
  await s.controller.close();
});

test('session shutdown drains in-flight launch, stops owned execution and is idempotent', async () => {
  const s = setup(), gate = deferred();
  s.backend.startWait = () => gate.promise;
  const work = s.pi.call('p2o_start', input);
  // Install rejection handler before lifecycle cancellation.
  const rejected = assert.rejects(work, /CANCELLED/);
  await nextTurn();
  const close = s.controller.close(); gate.resolve();
  await close; await rejected; await s.controller.close();
  assert.equal(s.backend.calls.filter(c => c === 'stop:run-1').length, 1);
  assert.equal(s.backend.calls.filter(c => c === 'close').length, 1);
  await assert.rejects(s.pi.call('p2o_status', { runId: 'run-1' }), /CLOSED/);
});

test('cleanup failures are propagated and do not claim termination success', async () => {
  const s = setup();
  await s.pi.call('p2o_start', input);
  s.backend.verifiedStop = false; s.backend.closeFailure = true;
  await assert.rejects(s.pi.event('session_shutdown'), /CLEANUP_UNVERIFIED/);
  assert.equal(s.pi.statuses.at(-1)?.text, undefined);
  assert.ok(s.backend.calls.includes('close'));
});

test('dashboard requires explicit opt-in and private UI; no token enters model output/session messages', async () => {
  const s = setup();
  await assert.rejects(s.pi.call('p2o_dashboard', { action: 'open', runId: 'run-1' }), /OPT_IN/);
  const headless = setup(false);
  await assert.rejects(headless.pi.call('p2o_dashboard', { action: 'open', runId: 'run-1', enabled: true }), /UI_REQUIRED/);
  assert.equal(headless.factories(), 0);
  await headless.controller.close();
  const result = await s.pi.call('p2o_dashboard', { action: 'open', runId: 'run-1', enabled: true });
  const notification = s.pi.notifications.find(n => n.message.includes('#token='))!;
  const token = notification.message.split('#token=')[1];
  assert.ok(token.length >= 40);
  assert.ok(!JSON.stringify(result).includes(token));
  await s.pi.command('p2o', 'status run-1');
  assert.ok(!JSON.stringify(s.pi.messages).includes(token));
  const url = (result.details as { url: string }).url;
  await s.pi.call('p2o_dashboard', { action: 'close' });
  assert.ok(!s.backend.calls.includes('stop:run-1'));
  await assert.rejects(fetch(url));
  await s.controller.close();
});

test('bundled default is usable but fails closed until an owner run is admitted, never selecting a fake backend', async () => {
  const old = process.env.P2O_CONTROL_MODULE;
  delete process.env.P2O_CONTROL_MODULE;
  try {
    const pi = fakePi(); p2oExtension(pi.api);
    // The packaged first-use composition loads, but with no owner-onboarded run it refuses instead of
    // inventing a fixture/plan: the refusal names the absence and launches nothing.
    for (const call of [() => pi.call('p2o_start', input), () => pi.call('p2o_status', { runId: 'run-1' })] as const) {
      await assert.rejects(call(), (error: Error) => {
        assert.match(error.message, /ENTRY_RUN_UNKNOWN/);
        assert.match(error.message, /no fake backend\/report/);
        return true;
      });
    }
    assert.equal(pi.messages.length, 0, 'a refused call must emit no result or success claim');
    await pi.event('session_shutdown');
  } finally { if (old !== undefined) process.env.P2O_CONTROL_MODULE = old; }
});

test('projection excludes uncertified raw logs/accessors and bounds tool content plus details', () => {
  const events = projectEvents({ items: [{ sequence: 1, eventId: 'e', type: 'worker.raw', occurredAt: 'now',
    payload: { token: 'DO_NOT_EXPOSE' }, display: { redacted: false, text: 'DO_NOT_EXPOSE', kind: 'log' } } as never], nextSequence: 1, gap: false });
  assert.ok(!JSON.stringify(events).includes('DO_NOT_EXPOSE'));
  const hostile = Object.defineProperty({ token: 'DO_NOT_EXPOSE', ok: true }, 'getter', { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.deepEqual(publicValue(hostile), { ok: true });
  const huge = Array.from({ length: 100 }, () => ({ claim: '💡'.repeat(5000) }));
  const result = boundedOutput(huge);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= 48 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(result.value)) <= 48 * 1024);
  assert.throws(() => validate('dashboard', { action: 'close', enabled: false }), /INVALID_INPUT/);
});
