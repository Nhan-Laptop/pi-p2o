// CONTRACT ONLY: stub UI/backend tests; not evidence of live model, target or runtime execution.
import { describe, expect, test } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import { FakeBackend, FakeEntry, fakePi, input } from '../interface/helpers.js';

import { contractOwnerConsent } from './owner-consent-fixture.js';
function setup(hasUI = true) {
  const pi = fakePi(hasUI), backend = new FakeBackend(), entry = new FakeEntry();
  backend.entry = entry;
  const controller = registerP2O(pi.api, { backendFactory: () => backend, onboardingFor: contractOwnerConsent });
  return { pi, backend, entry, controller };
}

const lastMessage = (pi: ReturnType<typeof fakePi>) => pi.messages.at(-1);
const lastText = (pi: ReturnType<typeof fakePi>) => String(pi.messages.at(-1)?.content ?? '');

describe('single human entrypoint', () => {
  test('registers exactly one slash command and keeps every p2o_* tool', async () => {
    const s = setup();
    expect([...s.pi.commands.keys()]).toEqual(['p2o']);
    expect([...s.pi.commands.keys()].some(name => name.startsWith('p2o_'))).toBe(false);
    expect(s.pi.tools.size).toBe(15);
    expect([...s.pi.tools.keys()]).toContain('p2o_start');
    await s.controller.close();
  });

  test('bare /p2o is help and reports one unambiguous current run only', async () => {
    const s = setup();
    await s.pi.command('p2o', '');
    expect(lastMessage(s.pi)?.customType).toBe('p2o_result');
    expect(lastText(s.pi)).toMatch(/status\|stop\|resume\|report/);
    expect(String((lastMessage(s.pi)?.details as { currentRun: unknown }).currentRun)).toBe('null');

    // No session run and no entry current run: status refuses to guess.
    await s.pi.command('p2o', 'status');
    expect(lastMessage(s.pi)?.customType).toBe('p2o_error');
    expect(lastText(s.pi)).toMatch(/RUN_ID_REQUIRED/);

    // The entry port's unambiguous current run is used when the session has none.
    s.entry.current = { runId: 'run-1', state: 'active' };
    await s.pi.command('p2o', 'status');
    expect(s.backend.calls).toContain('status');
    expect((lastMessage(s.pi)?.details as { runSource: string }).runSource).toBe('entry-current');
    expect(lastText(s.pi)).toMatch(/requested-provider/);
    await s.controller.close();
  });

  test('three target kinds dispatch to prepare/plan with zero target requests in plan-only mode', async () => {
    for (const [raw, kind] of [
      ['./local-repo', 'local-dir'],
      ['https://github.com/owner/repo', 'github-repo'],
      ['https://example.test/app?x=1', 'http-url'],
    ] as const) {
      const s = setup();
      await s.pi.command('p2o', `--target ${raw} --plan-only`);
      expect(s.entry.calls).toEqual([`prepare:${kind}`, 'plan']);
      expect(s.entry.calls).not.toContain('start');
      expect(s.entry.targetRequests).toBe(0);
      expect((lastMessage(s.pi)?.details as { targetRequests: number }).targetRequests).toBe(0);
      expect(lastText(s.pi)).toMatch(/no target request/i);
      expect(lastText(s.pi)).toMatch(/\/p2o approve plan-1/);
      await s.controller.close();
    }
  });

  test('unknown flags and invalid forms are denied before the workflow is contacted', async () => {
    const s = setup();
    for (const [args, code] of [
      ['--target ./repo --evil 1', /UNKNOWN_FLAG/],
      ['--target ./repo --budget 5', /UNKNOWN_FLAG/],
      ['--target ./repo --concurrency 0', /INVALID_CONCURRENCY/],
      ['--target ./repo --target ./other', /DUPLICATE_FLAG/],
      ['--target ./repo --depth extreme', /INVALID_DEPTH/],
      ['./repo', /UNKNOWN_VERB/],
      ['--target example.com', /UNSUPPORTED_TARGET/],
      ['--target git://example.com/repo', /UNSUPPORTED_TARGET/],
    ] as const) {
      await s.pi.command('p2o', args);
      expect(lastMessage(s.pi)?.customType).toBe('p2o_error');
      expect(lastText(s.pi)).toMatch(code);
    }
    expect(s.entry.calls).toEqual([]);
    expect(s.backend.calls).toEqual([]);
    await s.controller.close();
  });
});

describe('approval is a human decision', () => {
  test('no start without an interactive confirmation of scope, actions and spend', async () => {
    const s = setup(true);
    s.pi.setConfirm(false);
    await s.pi.command('p2o', '--target ./repo --purpose "audit auth" --concurrency 2');
    expect(s.entry.calls).not.toContain('start');
    expect(lastMessage(s.pi)?.customType).toBe('p2o_error');
    expect(lastText(s.pi)).toMatch(/NOT_APPROVED/);
    expect(s.pi.confirmCalls).toHaveLength(1);
    expect(s.pi.confirmCalls[0].message).toMatch(/scope:/);
    expect(s.pi.confirmCalls[0].message).toMatch(/spend:/);
    expect(s.pi.confirmCalls[0].message).toMatch(/no target request/);

    s.pi.setConfirm(true);
    await s.pi.command('p2o', '--target ./repo');
    expect(s.entry.calls).toContain('start');
    expect(s.entry.lastApproval?.channel).toBe('human-command');
    expect(s.entry.lastApproval?.scopeDigest).toBe('a'.repeat(64));
    await s.controller.close();
  });

  test('headless sessions cannot start or approve; plan-only still works and sends nothing', async () => {
    const s = setup(false);
    await s.pi.command('p2o', '--target ./repo');
    expect(s.entry.calls).not.toContain('start');
    expect(lastText(s.pi)).toMatch(/HUMAN_CONFIRMATION_REQUIRED/);
    await s.pi.command('p2o', 'approve plan-1');
    expect(s.entry.calls).not.toContain('approve:plan-1');
    expect(lastText(s.pi)).toMatch(/HUMAN_CONFIRMATION_REQUIRED/);

    await s.pi.command('p2o', '--target ./repo --plan-only');
    expect(s.entry.calls.filter(call => call === 'start' || call.startsWith('approve:'))).toEqual([]);
    expect(s.entry.calls).not.toContain('start');
    expect(s.entry.calls).not.toContain('approve:plan-1');
    await s.controller.close();
  });

  test('approve <planId> is the only approval path and admits exactly once', async () => {
    const s = setup();
    await s.pi.command('p2o', '--target ./repo --plan-only');
    await s.pi.command('p2o', 'approve plan-1');
    expect(s.entry.calls).toContain('approve:plan-1');
    expect(s.entry.lastApproval?.channel).toBe('human-command');
    expect(lastText(s.pi)).toMatch(/admitted once/);

    await s.pi.command('p2o', 'approve plan-1');
    expect(lastMessage(s.pi)?.customType).toBe('p2o_error');
    expect(lastText(s.pi)).toMatch(/ALREADY_APPROVED/);

    await s.pi.command('p2o', 'approve absent');
    expect(lastText(s.pi)).toMatch(/PLAN_NOT_FOUND/);
    await s.controller.close();
  });

  test('a session-recorded plan can be approved when the entry port exposes no plan reads', async () => {
    const s = setup();
    delete s.entry.readPlan;
    await s.pi.command('p2o', '--target https://example.test/app --plan-only');
    await s.pi.command('p2o', 'approve plan-1');
    expect(s.entry.calls).toContain('approve:plan-1');
    await s.controller.close();
  });

  test('tools cannot approve plans or reach the target workflow', async () => {
    const s = setup();
    await expect(s.pi.call('p2o_plan', { action: 'approve', runId: 'run-1', proposalDigest: 'a'.repeat(64), approvalPath: 'approval.json' }))
      .rejects.toThrow(/APPROVAL_HUMAN_ONLY/);
    await expect(s.pi.call('p2o_plan', { action: 'propose', runId: 'run-1', proposalPath: 'proposal.json' }))
      .rejects.toThrow(/INTEGRATION_REQUIRED/);
    await s.pi.call('p2o_status', { runId: 'run-1' });
    await s.pi.call('p2o_start', input);
    expect(s.entry.calls).toEqual([]);
    await s.controller.close();
  });

  test('a contract-violating workflow is refused, never reported as success', async () => {
    for (const overrides of [{ targetRequests: 1 }, { requiresHumanApproval: false }]) {
      const s = setup();
      s.entry.prepareOverrides = overrides;
      await s.pi.command('p2o', '--target ./repo');
      expect(lastMessage(s.pi)?.customType).toBe('p2o_error');
      expect(lastText(s.pi)).toMatch(/ENTRY_CONTRACT_VIOLATION/);
      expect(s.entry.calls).not.toContain('start');
      await s.controller.close();
    }
    const s = setup();
    s.entry.planOverrides = { targetRequests: 1 };
    await s.pi.command('p2o', '--target ./repo');
    expect(lastText(s.pi)).toMatch(/ENTRY_CONTRACT_VIOLATION/);
    expect(s.entry.calls).not.toContain('start');
    await s.controller.close();
  });

  test('an unwired target workflow fails closed for target, resume and approve', async () => {
    const s = setup();
    s.backend.entry = undefined;
    for (const args of ['--target ./repo --plan-only', 'resume run-1', 'approve plan-1']) {
      await s.pi.command('p2o', args);
      expect(lastMessage(s.pi)?.customType).toBe('p2o_error');
      expect(lastText(s.pi)).toMatch(/INTEGRATION_REQUIRED/);
    }
    await s.controller.close();
  });
});

describe('verified lifecycle semantics', () => {
  test('status/report/stop/resume use the session run and preserve verification gates', async () => {
    const s = setup();
    await s.pi.command('p2o', '--target ./repo');
    expect(s.entry.calls).toContain('start');
    const runId = (lastMessage(s.pi)?.details as { runId: string }).runId;

    await s.pi.command('p2o', 'status');
    expect(s.backend.calls).toContain('status');
    expect(lastText(s.pi)).toMatch(/requested-provider/);

    await s.pi.command('p2o', 'report');
    expect(s.backend.calls).toContain('report');
    expect(lastText(s.pi)).toMatch(/Qualified report/);

    await s.pi.command('p2o', 'stop');
    expect(s.entry.calls).toContain(`stop:${runId}`);

    await s.pi.command('p2o', 'resume run-1');
    expect(s.entry.calls).toContain('resume:run-1');
    expect(lastText(s.pi)).toMatch(/re-checked/);
    await s.controller.close();
  });

  test('unverified entry stop is refused and the legacy verified stop path is preserved', async () => {
    const s = setup();
    s.entry.stop = async runId => ({ runId, schedulingStopped: true, terminationVerified: false, failures: [] });
    await s.pi.command('p2o', 'stop run-1');
    expect(lastMessage(s.pi)?.customType).toBe('p2o_error');
    expect(lastText(s.pi)).toMatch(/STOP_UNVERIFIED/);

    delete s.entry.stop;
    await s.pi.command('p2o', 'stop run-1');
    expect(s.backend.calls).toContain('stop:run-1');
    expect(lastMessage(s.pi)?.customType).toBe('p2o_result');
    await s.controller.close();
  });

  test('resume checks the returned run identity and never fakes an environment restore', async () => {
    const s = setup();
    s.entry.runOverrides = { runId: 'other-run' };
    await s.pi.command('p2o', 'resume run-1');
    expect(lastMessage(s.pi)?.customType).toBe('p2o_error');
    expect(lastText(s.pi)).toMatch(/ENTRY_CONTRACT_VIOLATION/);
    await s.controller.close();
  });
});
