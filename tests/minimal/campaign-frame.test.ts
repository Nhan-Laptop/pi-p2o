import { describe, expect, it } from 'vitest';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * P5/A6.1 (planning_update.md §4): the campaign frame is recorded once, read by every projection, printed in the planner
 * prompt and the start confirmation, and absent for a manual run that never asked for one. Hermetic: the in-process
 * extension on a fake Pi, a real SQLite store, no model and no target.
 */
const PROMPT_SECTION = 'p2o_assessment';
const plannerPrompt = async (h: any): Promise<string> => {
  const event = { systemPromptOptions: { sections: {} as Record<string, string> }, prompt: '' };
  for (const handler of h.pi.events.get('before_agent_start') ?? []) await handler(event);
  return event.systemPromptOptions.sections[PROMPT_SECTION];
};

describe('campaign frame (A6.1)', () => {
  it('records the frame once from the start command and discloses the heartbeat before confirmation', async () => fixture(async h => {
    await h.command('--target ./source --goal "Assess the fixture boundary without changing state" --avoid "No payment flows" --heartbeat-seconds 300');
    // The operator consents to paid rounds before any is spent: the campaign line names the interval and that heartbeats cost.
    const confirmation = h.ctx.confirmBodies.at(-1) as string;
    expect(confirmation).toContain('Campaign');
    expect(confirmation).toContain('heartbeat 300s');
    expect(confirmation).toMatch(/heartbeats consume paid rounds/);
    const store = await h.reader();
    try {
      const campaign = store.campaign();
      // P7.1: the record is v2 now. This start named no --mode, so it carries the default exploit frame and the default
      // authorization (every effect class except availability-loss).
      expect(campaign).toMatchObject({ v: 2, objective: 'Assess the fixture boundary without changing state', heartbeatSeconds: 300, createdBy: 'operator', mode: 'exploit' });
      expect(campaign!.effectClasses).toEqual(['confidentiality-read', 'integrity-write', 'authentication-bypass', 'code-execution', 'cross-tenant-read', 'sandbox-escape']);
      expect(campaign!.constraints).toEqual([{ rule: 'deny', text: 'No payment flows' }]);
      expect(campaign!.targetRevision.length).toBeGreaterThan(0);
      expect(store.campaignRevision()).toBeGreaterThan(0);
      // Recorded once, never rewritten: a later plan write leaves the frame byte-identical.
      await h.call('p2o_plan_author', { entry: { kind: 'todo', title: 'Campaign step', status: 'open', reason: 'Bounded fixture step for the campaign frame' } });
      expect(store.campaign()).toEqual(campaign);
    } finally { store.close(); }
  }));

  it('prints the objective and every deny rule in the planner prompt, and nothing worker-only', async () => fixture(async h => {
    await h.command('--target ./source --goal "Assess the fixture boundary" --avoid "No payment flows" --avoid "Do not touch tenant B data"');
    const prompt = await plannerPrompt(h);
    expect(prompt).toContain('CAMPAIGN objective "Assess the fixture boundary"');
    expect(prompt).toContain('deny "No payment flows"');
    expect(prompt).toContain('deny "Do not touch tenant B data"');
    expect(prompt).toContain('may widen the operator objective');
    expect(prompt).toContain('must not silently narrow');
    // The campaign block is planner policy, not worker text.
    expect(prompt).not.toContain('WORKER ONLY');
    expect(prompt).not.toContain('p2o_report');
  }));

  it('carries the frame in the planner packet only, and derives a default campaign in event-driven mode', async () => fixture(async h => {
    await h.command('--target ./source --loop event-driven');
    // No --goal: the event-driven run still promised a campaign, so the objective is derived from the target and recorded once.
    const store = await h.reader();
    try {
      const campaign = store.campaign();
      expect(campaign).toMatchObject({ createdBy: 'default', heartbeatSeconds: 600 });
      expect(campaign!.objective).toContain('authorized target');
      const packet = store.contextPacket({ consumerId: 'planner-campaign', role: 'planner' });
      expect(packet.campaign).toMatchObject({ heartbeatSeconds: 600, createdBy: 'default' });
      expect(packet.campaign!.block).toContain('CAMPAIGN objective');
      // A worker never receives the campaign frame: it is planner composition, not task authority.
      expect(store.contextPacket({ consumerId: 'worker-campaign', role: 'worker', taskId: 'task-none' })).not.toHaveProperty('campaign');
    } finally { store.close(); }
    const prompt = await plannerPrompt(h);
    expect(prompt).toContain('CAMPAIGN objective');
  }));

  it('records no campaign for a manual run that asked for none, so A6.3/A6.6 keep today\'s behaviour', async () => fixture(async h => {
    await populate(h);
    const store = await h.reader();
    try {
      expect(store.campaign()).toBeUndefined();
      expect(store.campaignRevision()).toBeUndefined();
      expect(store.contextPacket({ consumerId: 'planner-plain', role: 'planner' })).not.toHaveProperty('campaign');
    } finally { store.close(); }
    const prompt = await plannerPrompt(h);
    expect(prompt).not.toContain('CAMPAIGN objective');
    // There is no tool that authors a campaign: the only writer is the human-confirmed start path.
    expect([...h.pi.tools.keys()].filter((name: string) => /campaign/i.test(name))).toEqual([]);
  }));
});
