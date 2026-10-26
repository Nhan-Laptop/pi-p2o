import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssessmentEngine, type EngineDeps, type PlannerWake, type RoundProgress } from '../../src/engine.js';

/**
 * P5/A6.3 (planning_update.md §4): the loop continues because work is owed, not because an event happened to arrive.
 * Hermetic: no model, no target, no store — a fake clock and fake timers drive the debt wake and the campaign heartbeat.
 */
function fixture(options: { mode?: 'manual' | 'event-driven'; heartbeat?: number; active?: boolean } = {}) {
  let active = options.active ?? true, clock = 1_000_000;
  const wakes: PlannerWake[] = [], journal: Array<{ text: string; data: any }> = [], problems: string[] = [];
  const deps: EngineDeps = {
    active: () => active, list: async () => [], readiness: async () => ({ ready: true }), capacity: () => 1,
    reap: async () => true, spawn: async () => undefined, persist: async (text, data) => { journal.push({ text, data }); },
    wake: wake => wakes.push(wake), idle: () => true, problem: reason => problems.push(reason),
    now: () => clock, heartbeatSeconds: () => options.heartbeat ?? 0,
  };
  const engine = new AssessmentEngine('run-campaign', options.mode ?? 'event-driven', deps, 5);
  const round = (patch: Partial<RoundProgress> = {}): RoundProgress => ({ testedCells: 0, closures: 0, assets: 0, chainDepth: 0, remaining: 0, ...patch });
  /** Move the caller-owned clock without firing timers, so pacing and heartbeat timing are tested separately. */
  const advance = (ms: number) => { clock += ms; };
  return { engine, wakes, journal, problems, round, advance, setActive: (value: boolean) => { active = value; } };
}
const owed = (patch: Partial<RoundProgress> = {}) => ({ remaining: 2, debt: { gateable: 2, total: 2 }, demand: '2 research debt item(s): CELL_NOT_RUN 2', ...patch });
const stall = { openGoal: true, openIntents: 0 } as const;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('obligation-driven continuation (A6.3)', () => {
  it('reserves a debt wake at the first round boundary even with zero events, and nothing when nothing is owed', async () => {
    const quietRun = fixture({ heartbeat: 600 });
    quietRun.engine.notify('worker-report', 'w1');
    const eventWake = quietRun.engine.boundary()!;
    expect(eventWake.reason).toBe('event');
    quietRun.engine.consume(eventWake.through, quietRun.round());
    // A complete run owes nothing: zero events and remaining=0 is not a reason to spend a round.
    expect(quietRun.engine.boundary()).toBeUndefined();
    expect(quietRun.engine.snapshot().lastWake).toMatchObject({ reason: 'event', round: 1 });
    quietRun.engine.stop();

    const owedRun = fixture({ heartbeat: 600 });
    owedRun.engine.notify('worker-report', 'w1');
    const first = owedRun.engine.boundary()!;
    owedRun.engine.consume(first.through, owedRun.round(owed()));
    // The branch that would have continued the observed run at 04:00: no new event, work still owed.
    const debtWake = owedRun.engine.boundary()!;
    expect(debtWake).toMatchObject({ reason: 'debt', round: 2 });
    expect(debtWake.demand).toContain('2 research debt item(s)');
    expect(owedRun.engine.snapshot()).toMatchObject({ rounds: 2, lastWake: { reason: 'debt', round: 2 } });
    owedRun.engine.stop();
  });

  it('paces later debt wakes by the heartbeat interval and resumes after it', () => {
    const f = fixture({ heartbeat: 600 });
    f.engine.consume(0, f.round(owed()));
    expect(f.engine.boundary()?.reason).toBe('debt');
    f.engine.consume(0, f.round(owed()));
    // Inside the interval the same obligation is not re-woken; the planner may be working on it.
    expect(f.engine.boundary()).toBeUndefined();
    f.advance(599_000);
    expect(f.engine.boundary()).toBeUndefined();
    f.advance(2_000);
    expect(f.engine.boundary()?.reason).toBe('debt');
    f.engine.stop();
  });

  it('suppresses the debt wake after an explicit loop wait but never suppresses an event wake', async () => {
    const f = fixture({ heartbeat: 600 });
    f.engine.consume(0, f.round(owed()));
    await f.engine.disposition('wait', 'waiting for the operator to grant a credential');
    expect(f.engine.boundary()).toBeUndefined();
    f.engine.notify('worker-report', 'w1');
    expect(f.engine.boundary()?.reason).toBe('event');
    // resume() clears the disposition, so the next boundary owes work again.
    f.engine.consume(f.engine.snapshot().sequence, f.round(owed()));
    f.engine.resume();
    expect(f.engine.boundary()?.reason).toBe('debt');
    f.engine.stop();
  });

  it('does not wake on debt in manual mode, where an automatic round would contradict the mode', () => {
    const f = fixture({ mode: 'manual' });
    f.engine.consume(0, f.round(owed()));
    expect(f.engine.boundary()).toBeUndefined();
    f.engine.stop();
  });

  it('fires one heartbeat at the interval with zero events, carries its demand, and never fires inside a turn', async () => {
    const f = fixture({ heartbeat: 600 });
    f.engine.start();
    f.engine.consume(0, f.round(owed()));
    // An explicit wait suppresses the immediate debt wake so this test observes the heartbeat itself.
    await f.engine.disposition('wait', 'waiting for the next heartbeat');
    f.engine.started();
    f.advance(600_000); await vi.advanceTimersByTimeAsync(600_000);
    expect(f.wakes).toHaveLength(0);
    f.engine.settled();
    f.advance(600_000); await vi.advanceTimersByTimeAsync(600_000);
    expect(f.wakes).toHaveLength(1);
    expect(f.wakes[0]).toMatchObject({ reason: 'heartbeat', round: 1 });
    expect(f.wakes[0].demand).toContain('heartbeat 600s');
    expect(f.wakes[0].demand).toContain('2 research debt item(s)');
    expect(f.engine.snapshot().heartbeat).toMatchObject({ seconds: 600 });
    expect(f.engine.snapshot().lastWake).toMatchObject({ reason: 'heartbeat' });
    f.engine.stop();
  });

  it('never fires the heartbeat while paused, stopped, inactive or disabled', async () => {
    const paused = fixture({ heartbeat: 600 });
    paused.engine.start();
    paused.engine.pause('Human pause');
    paused.advance(600_000); await vi.advanceTimersByTimeAsync(600_000);
    expect(paused.wakes).toEqual([]);
    paused.engine.stop();

    const stopped = fixture({ heartbeat: 600 });
    stopped.engine.start(); stopped.engine.stop();
    stopped.advance(600_000); await vi.advanceTimersByTimeAsync(600_000);
    expect(stopped.wakes).toEqual([]);

    const inactive = fixture({ heartbeat: 600 });
    inactive.engine.start(); inactive.setActive(false);
    inactive.advance(600_000); await vi.advanceTimersByTimeAsync(600_000);
    expect(inactive.wakes).toEqual([]);
    inactive.engine.stop();

    const disabled = fixture({ heartbeat: 0 });
    disabled.engine.start();
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(disabled.wakes).toEqual([]);
    expect(disabled.engine.snapshot().heartbeat).toEqual({ seconds: 0 });
    disabled.engine.stop();
  });

  it('pauses after three stalled rounds while research debt remains, and resume starts a fresh escalation streak', async () => {
    const f = fixture({});
    f.engine.consume(0, f.round({ remaining: 1, debt: { gateable: 1, total: 1 } }));
    // P5.1: a stalled round only exists after an admitted round; begin one at the boundary before stalling.
    const debtWake = f.engine.boundary()!;
    expect(debtWake).toMatchObject({ reason: 'debt', round: 1 });
    f.engine.consume(debtWake.through, f.round({ remaining: 1, debt: { gateable: 1, total: 1 } }));
    expect(await f.engine.stallRound(stall)).toBe(true);
    expect(await f.engine.stallRound(stall)).toBe(true);
    expect(f.engine.snapshot().paused).toBeUndefined();
    expect(await f.engine.stallRound(stall)).toBe(true);
    expect(f.engine.snapshot().paused).toMatch(/three rounds with no open intent while research debt remains/);
    expect(f.problems.at(-1)).toMatch(/human decision \(\/p2o resume or \/p2o stop\)/);
    const escalation = f.journal.find(entry => entry.data?.event === 'planner.stall-escalation');
    expect(escalation?.data).toMatchObject({ stalls: 3, debt: { gateable: 1, total: 1 } });
    // No budget is written or invented anywhere: the pause asks for a human, it does not raise a ceiling.
    expect(f.journal.every(entry => !('budget' in (entry.data ?? {})))).toBe(true);
    expect(f.engine.snapshot()).not.toHaveProperty('budget');
    f.engine.resume();
    expect(f.engine.snapshot().paused).toBeUndefined();
    // P5.1: the measured gate run paused again on the very next stall because the counter was cumulative. A resume is a new
    // baseline, so three *new* stalled rounds are needed before the loop asks a human again.
    expect(f.engine.snapshot().stalls).toBe(0);
    expect(await f.engine.stallRound(stall)).toBe(true);
    expect(await f.engine.stallRound(stall)).toBe(true);
    expect(f.engine.snapshot().paused).toBeUndefined();
    expect(await f.engine.stallRound(stall)).toBe(true);
    expect(f.engine.snapshot().paused).toMatch(/three rounds with no open intent while research debt remains/);
    f.engine.resume();
    f.engine.stop();
  });

  it('records no stall fact before a planner round is admitted, so the startup command turn cannot escalate', async () => {
    const f = fixture({});
    f.engine.consume(0, f.round({ remaining: 1, debt: { gateable: 1, total: 1 } }));
    // Measured gate run: `planner.stalled` with rounds:0 twice at startup, then a third stall escalated before any round.
    for (let i = 0; i < 3; i++) expect(await f.engine.stallRound(stall)).toBe(false);
    expect(f.engine.snapshot()).toMatchObject({ rounds: 0, stalls: 0 });
    expect(f.journal.some(entry => entry.data?.event === 'planner.stalled')).toBe(false);
    expect(f.engine.snapshot().paused).toBeUndefined();
    f.engine.stop();
  });

  it('lets the heartbeat continue the loop after a single stalled round instead of pausing', async () => {
    const f = fixture({ heartbeat: 600 });
    f.engine.start();
    f.engine.consume(0, f.round(owed()));
    const debtWake = f.engine.boundary()!;
    f.engine.consume(debtWake.through, f.round(owed()));
    // One stalled round is below the escalation threshold, so the campaign must continue by itself on the heartbeat.
    expect(await f.engine.stallRound(stall)).toBe(true);
    expect(f.engine.snapshot().paused).toBeUndefined();
    f.advance(600_000); await vi.advanceTimersByTimeAsync(600_000);
    expect(f.wakes.at(-1)).toMatchObject({ reason: 'heartbeat' });
    expect(f.engine.snapshot().paused).toBeUndefined();
    f.engine.stop();
  });

  it('stamps the round start so status can report how long the current round has run', () => {
    const f = fixture({ heartbeat: 600 });
    f.engine.consume(0, f.round(owed()));
    expect(f.engine.boundary()?.reason).toBe('debt');
    expect(f.engine.snapshot().roundStartedAt).toBe(new Date(1_000_000).toISOString());
    f.advance(600_000);
    f.engine.consume(0, f.round(owed()));
    expect(f.engine.boundary()?.reason).toBe('debt');
    // A6.5: the timestamp is the start of the round it is reported with, not the end of the previous one.
    expect(f.engine.snapshot()).toMatchObject({ rounds: 2, roundStartedAt: new Date(1_600_000).toISOString() });
    f.engine.stop();
  });

  it('keeps three stalled rounds without gateable debt as report facts only (A4 unchanged)', async () => {
    const f = fixture({});
    // An admitted round is required before a round can be judged as stalled (P5.1).
    f.engine.notify('worker-report', 'w1');
    const eventWake = f.engine.boundary()!;
    expect(eventWake.reason).toBe('event');
    f.engine.consume(eventWake.through, f.round());
    for (let i = 0; i < 3; i++) expect(await f.engine.stallRound(stall)).toBe(true);
    expect(f.engine.snapshot().paused).toBeUndefined();
    expect(f.engine.snapshot().stalls).toBe(3);
    expect(f.journal.some(entry => entry.data?.event === 'planner.stall-escalation')).toBe(false);
    f.engine.stop();
  });
});
