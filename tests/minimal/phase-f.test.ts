import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssessmentEngine, type EngineDeps, type PlannerWake } from '../../src/engine.js';
import { continuationRefusal, type WorkerRegistration } from '../../src/broker.js';
import { finishPreflight } from '../../src/finish-preflight.js';
import { readLedger } from '../../src/records.js';
import { fixture, seedClaim, seedImpactGoal } from './helpers/report-fixture.js';

/**
 * Phase F acceptance (M6 + M7 + M8). Quiet rounds escalate with both round ids and the human decision — never a budget word;
 * a revisit is one condition-bound wake, recorded once and refused twice; a continuation is one more brief on a live ticket and
 * a refusal once that ticket is retired; and a blocked link names the transition to research instead of leaving the lead guessing.
 */
function engineFixture() {
  const wakes: PlannerWake[] = [], problems: string[] = [];
  const deps: EngineDeps = {
    active: () => true, list: async () => [], readiness: async () => ({ ready: true }), capacity: () => 1, reap: async () => true,
    spawn: async () => undefined, persist: async () => undefined, wake: wake => wakes.push(wake), idle: () => true, problem: reason => problems.push(reason),
  };
  return { engine: new AssessmentEngine('run-f', 'event-driven', deps, 5), wakes, problems };
}
const QUIET = { testedCells: 0, closures: 0, assets: 0, chainDepth: 0, remaining: 0 };
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('quiet rounds escalate to a human, never to a number (M6)', () => {
  it('stops automatic wakes after two quiet rounds on a complete run and names both of them', () => {
    const { engine, problems } = engineFixture();
    engine.notify('worker-report', 'w1');
    const first = engine.boundary()!;
    engine.consume(first.through, QUIET);
    engine.notify('worker-report', 'w2');
    const second = engine.boundary()!;
    engine.consume(second.through, QUIET);
    expect(engine.quietRounds()).toEqual([1, 2]);
    engine.notify('worker-report', 'w3');
    // P16.2: with nothing owed (remaining 0) the loop goes quiet; the demand path is tested in phase-h.
    expect(engine.boundary()).toBeUndefined();
    const message = problems.at(-1)!;
    expect(message).toContain('rounds 1 and 2');
    expect(message).toContain('completion is complete');
    // No allowance vocabulary: escalation is about progress the run cannot make, not about spending anything.
    expect(message).not.toMatch(/budget|allowance|quota|commands? remaining/i);
    expect(engine.snapshot().state).toBe('blocked');
    engine.stop();
  });

  it('resets the streak as soon as a round adds a tested cell, closure, asset or chain depth', () => {
    const { engine, problems } = engineFixture();
    engine.notify('worker-report', 'w1');
    const first = engine.boundary()!;
    engine.consume(first.through, QUIET);
    engine.notify('worker-report', 'w2');
    const second = engine.boundary()!;
    engine.consume(second.through, { ...QUIET, testedCells: 1 });
    expect(engine.quietRounds()).toEqual([]);
    engine.notify('worker-report', 'w3');
    expect(engine.boundary()).toBeDefined();
    expect(problems).toEqual([]);
    engine.stop();
  });

});

describe('a revisit is condition-bounded and fires once (M7)', () => {
  it('schedules one wake per condition and refuses a second pending one for the same condition', async () => {
    const { engine, wakes } = engineFixture();
    const at = Date.now() + 1000;
    expect(engine.revisitAt('block-decay')).toBeUndefined();
    expect(engine.scheduleRevisit('block-decay', at)).toMatchObject({ condition: 'block-decay' });
    expect(engine.revisitAt('block-decay')).toBe(at);
    expect(() => engine.scheduleRevisit('block-decay', at + 5000))
      .toThrow(`REVISIT_DUPLICATE: condition block-decay already has a pending revisit at ${new Date(at).toISOString()}`);
    await vi.advanceTimersByTimeAsync(1000);
    expect(wakes.map(wake => wake.round)).toEqual([1]);
    expect(engine.revisitAt('block-decay')).toBeUndefined();
    // It never re-arms itself: another minute passes and the same condition stays quiet.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wakes).toHaveLength(1);
    // A different condition is a different revisit, not a duplicate.
    engine.scheduleRevisit('cooldown-expiry', Date.now() + 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(wakes.map(wake => wake.round)).toEqual([1, 2]);
    engine.stop();
  });

  it('fires nothing while the run is paused or stopped', async () => {
    const { engine, wakes } = engineFixture();
    engine.scheduleRevisit('block-decay', Date.now() + 1000);
    engine.pause('operator hold');
    await vi.advanceTimersByTimeAsync(2000);
    expect(wakes).toEqual([]);
    engine.resume();
    const second = engineFixture();
    second.engine.scheduleRevisit('cooldown-expiry', Date.now() + 1000);
    second.engine.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(second.wakes).toEqual([]);
  });
});

describe('continuation is bounded by the ticket, not by a count (M8)', () => {
  const worker = (overrides: Partial<WorkerRegistration> = {}) => ({ workerId: 'worker-a', stopped: false, continues: 0, ...overrides } as WorkerRegistration);

  it('continues a live ticket as often as it is useful, and refuses a reporter or a closed pane', () => {
    expect(continuationRefusal(worker())).toBeUndefined();
    // The ticket, not a count, decides: a live conversation can be steered again.
    expect(continuationRefusal(worker({ continues: 7 }))).toBeUndefined();
    expect(continuationRefusal(worker({ reported: { summary: 'done', findings: [], evidence: [], coverage: [], openItems: [], confidence: 'high' } }))).toMatch(/^WORKER_CLOSED: the worker already reported/);
    expect(continuationRefusal(worker({ stopped: true }))).toMatch(/^WORKER_CLOSED: the worker is stopped/);
    expect(continuationRefusal(worker({ paneClosed: true }))).toMatch(/^WORKER_CLOSED: /);
  });
});

describe('the run tells the lead what to research, and records its refusals (M6 + M8)', () => {
  it('names the transition and the procedure skill when a link blocks', async () => fixture(async h => {
    await h.command('--target ./source');
    const observation = (await h.call('p2o_shell', { command: 'printf phase-f-observation' })).details;
    await seedClaim(h, { candidate: 'blocked-link', surface: '/report-fixture', risk: 'authorization', closure: 'open_proof_gap', execution: 'not_tested',
      proof: 'static_trace', negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'Nothing executed in this step yet',
      evidenceRefs: [observation.evidenceId], needs: [{ kind: 'net.egress', subject: 'internal-api' }], gained: [{ kind: 'exec.code', subject: 'app-host' }] });
    const join = (await h.call('p2o_graph_plan', { action: 'chain' })).details;
    expect(join.unmet).toContain('blocked-link');
    // The hint names the transition it needs (`needs X → gained Y`), not a topic, and the skill that owns it.
    expect(join.research).toEqual([{ claimId: 'blocked-link', tool: 'p2o_research', needs: 'net.egress (internal-api)', gained: 'exec.code (app-host)',
      query: 'net.egress (internal-api) to exec.code (app-host) on /report-fixture', skill: 'ssrf-to-internal' }]);
  }));

  it('records a condition-bounded revisit as one decision and refuses the second (M7)', async () => fixture(async h => {
    await h.command('--target ./source');
    const at = new Date(Date.now() + 300_000).toISOString();
    const waited = await h.call('p2o_loop', { action: 'wait', reason: 'block-decay', notBefore: at });
    expect(waited.details.revisit).toEqual({ condition: 'block-decay', at });
    expect(waited.terminate).toBe(true);
    const decisions = (await h.call('p2o_board', { board: 'plans', kind: 'decision', limit: 20 })).details;
    expect(decisions.total).toBe(1);
    await expect(h.call('p2o_loop', { action: 'wait', reason: 'block-decay', notBefore: at }))
      .rejects.toThrow(/REVISIT_DUPLICATE: condition block-decay already has a pending revisit at/);
    // The duplicate was refused before anything was written: one decision, one schedule.
    expect((await h.call('p2o_board', { board: 'plans', kind: 'decision', limit: 20 })).details.total).toBe(1);
    // The reason vocabulary is closed: a revisit is a stated condition, not free text with a timer attached.
    await expect(h.call('p2o_loop', { action: 'wait', reason: 'because I said so', notBefore: at }))
      .rejects.toThrow(/needs reason block-decay or cooldown-expiry/);
  }));

  it('refuses to continue a worker that is not in this run (M8 wiring)', async () => fixture(async h => {
    await h.command('--target ./source');
    await expect(h.call('p2o_workers', { action: 'continue', workerId: 'worker-missing', brief: 'Try the other parser on the same ticket' }))
      .rejects.toThrow(/WORKER_UNKNOWN/);
  }));

  it('fills work.purpose from the role instead of demanding it twice', async () => fixture(async h => {
    await h.command('--target ./source');
    // A3/D32: the impact goal must exist before the first target-executing intent, which is still this run's recon intent.
    await seedImpactGoal(h);
    const asset = (await h.call('p2o_graph_record', { batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /report-fixture' } }] } })).details.acks[0];
    const observation = (await h.call('p2o_shell', { command: 'printf purpose-observation' })).details;
    const parent = await seedClaim(h, { candidate: 'purpose-parent', surface: '/report-fixture', risk: 'authorization', closure: 'open_proof_gap',
      execution: 'not_tested', proof: 'static_trace', negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Declared fixture actor/object boundary',
      limitations: 'Nothing executed in this step yet', evidenceRefs: [observation.evidenceId], gained: [{ kind: 'http.request', subject: 'internal-api' }] });
    // A2: the first intent of a run must be recon/mapping; this fixture's subject is the later structured intent.
    await h.call('p2o_task_author', {entry: { question: 'Which recorded surfaces does the retained fixture graph expose?', surface: '/report-fixture',
      risk: 'mapping', role: 'recon', evidenceIds: [], prerequisites: [] }});
    // P7.1: exploit mode (the default) needs a capability-proof goal before an exploitation intent is admitted.
    await h.call('p2o_goal_author', {entry: {kind: 'goal', title: 'Reach the fixture effect under an impact goal', status: 'active',
      proof: {kind: 'capability', capability: {kind: 'file.read'}}, criteria: ['The bounded fixture step is recorded'],
      reason: 'P7.1 exploit-mode admission fixture: the impact goal the exploitation intent is settled against'}});
    const created = (await h.call('p2o_task_author', {entry: {
      question: 'Does the bounded fixture reach the declared effect?', surface: '/report-fixture', risk: 'authorization', role: 'exploit',
      roleReason: 'Purpose fixture role', expectedTrue: 'The bounded observation is recorded', expectedFalse: 'The bounded control is recorded',
      stopCondition: 'Stop after one inert observation', evidenceIds: [], prerequisites: [], skills: [], methodReason: 'One inert observation with no external target',
      // No purpose: the role already says `exploitation`, and the board fills it rather than refusing the draft.
      work: { assetRefs: [{ id: asset.entityId, revision: 1 }], questionKey: 'q:purpose', methodFamily: 'fixture', claimRefs: [parent.id] },
      decision: { disposition: 'new', reason: 'Purpose fixture takes its own bounded step' },
      outputContract: { kind: 'validation', required: ['evidence', 'candidates'], partialAllowed: false, artifactPolicy: 'ids-only' },
    } })).details;
    expect(created.work.purpose).toBe('exploitation');
  }));

  it('records an admission refusal once and counts it as an advisory', async () => fixture(async h => {
    await h.command('--target ./source');
    // A3/D32: seed the impact goal so the refusal under test is the frontier obligation, not the missing goal.
    await seedImpactGoal(h);
    const observation = (await h.call('p2o_shell', { command: 'printf admission-observation' })).details;
    await seedClaim(h, { candidate: 'unconsumed', surface: '/report-fixture', risk: 'authorization', closure: 'confirmed', execution: 'tested', proof: 'live_reproduction',
      policyBasis: 'boundary_invariant', negativeControls: [], expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'Bounded fixture only', evidenceRefs: [observation.evidenceId],
      gained: [{ kind: 'http.request', subject: 'internal-api' }] });
    const broad = { question: 'Does the bounded fixture respond?', surface: '/report-fixture', risk: 'authorization', role: 'general', roleReason: 'Admission fixture breadth',
      expectedTrue: 'The bounded observation is recorded', expectedFalse: 'The bounded control is recorded', stopCondition: 'Stop after one inert observation',
      evidenceIds: [], prerequisites: [], skills: [], methodReason: 'One inert observation with no external target' };
    await expect(h.call('p2o_task_author', {entry: broad })).rejects.toThrow(/PRIMITIVE_UNCHAINED/);
    // The refusal is a record, and the export lists it: the admission tax is visible instead of living only in the transcript.
    const exported = await h.call('p2o_finish', { export: true });
    expect(exported.details.preflight.advisory.find((item: any) => item.code === 'ADMISSION_REFUSALS')).toMatchObject({ count: 1, level: 'advisory' });
    const store = await h.reader();
    try { expect(store.records().filter((row: any) => row.kind === 'lifecycle' && String(row.text).startsWith('admission refused: PRIMITIVE_UNCHAINED'))).toHaveLength(1); }
    finally { store.close(); }
  }));
  it('turns a condition-bounded wait into one recorded revisit, and refuses a second one', async () => fixture(async h => {
    await h.command('--target ./source');
    const at = new Date(Date.now() + 60_000).toISOString();
    const waited = await h.call('p2o_loop', { action: 'wait', reason: 'block-decay', notBefore: at });
    // The wake is bound to one condition and one instant: the lead gets a time, not an allowance.
    expect(waited.details.revisit).toMatchObject({ condition: 'block-decay' });
    expect(new Date(waited.details.revisit.at).toISOString()).toBe(at);
    const plans = await h.call('p2o_board', { board: 'plans', kind: 'decision' });
    expect(JSON.stringify(plans.details)).toContain('Revisit block-decay');
    expect(JSON.stringify(plans.details)).toContain(`${'block-decay'} at ${at}`);
    // A second wait for the same condition is a scheduling question the record already answers.
    await expect(h.call('p2o_loop', { action: 'wait', reason: 'block-decay', notBefore: new Date(Date.now() + 90_000).toISOString() })).rejects.toThrow(/REVISIT_DUPLICATE/);
  }));

  it('refuses a continuation for a worker this assessment never registered', async () => fixture(async h => {
    await h.command('--target ./source');
    await expect(h.call('p2o_workers', { action: 'continue', workerId: 'w-unknown', brief: 'try the blocked hypothesis with a different marker' })).rejects.toThrow(/WORKER_UNKNOWN/);
  }));
});
