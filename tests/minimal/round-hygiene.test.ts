import { describe, expect, it } from 'vitest';
import { indexRecords } from '../../src/records.js';
import { plannerInstructions } from '../../src/prompts.js';
import { statusView, type ViewProfile } from '../../src/ui/state.js';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * P5/A6.5 (planning_update.md §4): round hygiene and campaign memory. The round — not the transcript — is the unit of work:
 * the prompt says to end it, status shows which round is running and why it was woken, and a campaign that dispatches before
 * it recorded a frame is named as debt (no new refusal, per the A6 design boundary). Hermetic: no model, no target.
 */
const text = (result: any) => result.content[0].text as string;

describe('round hygiene and campaign memory (A6.5)', () => {
  it('states the round-ending guidance, the first-round contract and the phase checkpoint in the planner policy', () => {
    const planner = plannerInstructions({ runId: 'run-hygiene', targetLabel: 'https://fixture.invalid', targetKind: 'url', sourceSkipped: 0,
      delegation: { enabled: true, maxWorkers: 3, maxDepth: 2 }, phase: 'active', loopMode: 'event-driven', executorMode: 'shared' });
    expect(planner).toContain('ROUND HYGIENE');
    // A1: the policy section carries the rule, not tool names — the tool descriptions own usage (workflow-policy pins it).
    expect(planner).toContain('end the round explicitly with the loop wait action');
    expect(planner).toContain('worker join only for a bounded join');
    expect(planner).not.toMatch(/\bp2o_[a-z_]+\b/);
    expect(planner).toContain('FIRST ROUND');
    expect(planner).toContain('before the first task dispatch');
    expect(planner).toContain('PHASE CLOSE');
    expect(planner).toContain('next phase starting question');
  });

  it('renders the campaign, the round number, the last wake reason and the round-start time in status', () => {
    const profile = {
      runId: 'run-hygiene', target: '/target', lifecycle: 'active', delegation: true, maxWorkers: 3,
      exportEnabled: false, engine: { mode: 'event-driven', rounds: 3, pendingIntents: 0, paused: undefined, decision: undefined,
        lastWake: { reason: 'debt', round: 3 }, roundStartedAt: '2030-01-01T00:10:00.000Z', heartbeat: { seconds: 600, nextAt: '2030-01-01T00:20:00.000Z' } },
      executor: { mode: 'shared', maxTargetOperations: 1 },
      campaign: { objective: 'Assess the fixture boundary', heartbeatSeconds: 600, createdBy: 'operator' as const },
      workers: [],
    } as unknown as ViewProfile;
    const lines = statusView(indexRecords([]), profile).lines.join('\n');
    expect(lines).toContain('Campaign: Assess the fixture boundary (operator)');
    expect(lines).toContain('heartbeat 600s');
    expect(lines).toContain('rounds 3');
    expect(lines).toContain('last wake debt round 3');
    expect(lines).toContain('round started 2030-01-01T00:10:00.000Z');
    // The round/wake facts render even without a campaign record; only the objective line changes.
    expect(statusView(indexRecords([]), { ...profile, campaign: undefined }).lines.join('\n')).toContain('Campaign: no campaign record');
  });

  it('names a dispatch made before a goal or plan as research debt instead of refusing it (design boundary)', async () => fixture(async h => {
    await h.command('--target ./source --goal "Assess the fixture boundary"');
    // A6.5's first-round contract is enforced as debt and prompt guidance, not as a second refusal: the dispatch is admitted
    // and the frame it skipped is named by the same derivation the loop and the report read.
    await h.call('p2o_task_create', { draft: { question: 'Does the fixture boundary hold for the first recon intent?', surface: '/fixture', risk: 'mapping', role: 'recon',
      roleReason: 'First-round contract fixture', expectedTrue: 'The recorded fixture exposes the declared boundary', expectedFalse: 'The fixture records nothing and the receipt says so',
      stopCondition: 'Stop after one inert mapping intent', evidenceIds: [], prerequisites: [], skills: [], methodReason: 'No target or model work' } });
    const exported = await h.call('p2o_finish', { export: true });
    const codes = exported.details.completion.items.map((item: { code: string }) => item.code);
    expect(codes).toContain('RESEARCH_DEBT');
    const debt = exported.details.debt;
    expect(debt.totals.GOAL_MISSING).toBe(1);
    expect(debt.totals.PLAN_MISSING).toBe(1);
    expect(text(exported)).toContain('STATE: incomplete');
    // The prompt names the legal path, so the advisory is actionable rather than just a counter.
    const prompt = await (async () => {
      const event = { systemPromptOptions: { sections: {} as Record<string, string> }, prompt: '' };
      for (const handler of h.pi.events.get('before_agent_start') ?? []) await handler(event);
      return event.systemPromptOptions.sections['p2o_assessment'];
    })();
    expect(prompt).toContain('FIRST ROUND');
    expect(prompt).toContain('record the goal');
  }));
});
