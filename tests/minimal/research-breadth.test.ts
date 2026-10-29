import { describe, expect, it } from 'vitest';
import { SITUATION_LIMIT, situationLine, situationSegments, summarizeSituation } from '../../src/situation.js';
import { ROUND_BRIEF_MAX_BYTES, ROUND_BRIEF_SECTION_CAPS, buildRoundBrief } from '../../src/round-brief.js';
import { completionDemand, deriveCompletion } from '../../src/completion.js';
import { coverageRevisionDemand } from '../../src/coverage.js';
import { isWstgKey, wstgQuestionQueue } from '../../src/wstg-map.js';
import { plannerInstructions, type PlannerPromptFacts } from '../../src/prompts.js';
import type { ChainClaim } from '../../src/chain-view.js';
import type { PlanEntry } from '../../src/planning.js';
import type { AssessmentTask } from '../../src/tasks.js';
import { fixture, seedImpactGoal } from './helpers/report-fixture.js';

/**
 * planning_update.md §7 (P21/C): a run does not finish while known, feasible questions remain. The breadth rows are derived
 * from the coverage, WSTG and debt projections the host already owns; the queue and the situation/brief counters are pure reads
 * that can neither satisfy anything nor write a cell. Hermetic: no model, no target, no live run.
 */
const plan = (seed: Pick<PlanEntry, 'id' | 'kind' | 'title' | 'status'> & Partial<PlanEntry>): PlanEntry => ({
  runId: 'run-breadth', revision: 1, recordId: `record-${seed.id}`, reason: 'fixture row recorded for the breadth test', ...seed,
});
const claim = (recordId: string, overrides: Partial<ChainClaim> = {}): ChainClaim => ({
  candidate: recordId, recordId, closure: 'open_proof_gap', execution: 'not_tested', surface: '/fixture', ...overrides,
});
const baseFacts: PlannerPromptFacts = { runId: 'run-breadth', targetKind: 'directory', targetLabel: '/target', sourceSkipped: 0,
  delegation: { enabled: true, maxWorkers: 2, maxDepth: 1 }, phase: 'active', executorMode: 'shared' };

describe('situation breadth counters (P21/C1)', () => {
  it('keeps the exact caller count and at most three samples per breadth row', () => {
    const snapshot = summarizeSituation({ tasks: [], cases: [], coverage: [], claims: [],
      unplannedAssets: { count: 68, samples: ['endpoint /a', 'endpoint /b', 'endpoint /c', 'endpoint /d'] },
      wstgUnplanned: { count: 2, samples: ['wstg-athz-04', 'wstg-sess-05'] },
      untriagedGaps: { count: 1, samples: ['open-gap-1'] } });
    expect(snapshot.unplannedAssets).toBe(68);
    expect(snapshot.unplannedSamples).toEqual(['endpoint /a', 'endpoint /b', 'endpoint /c']);
    expect(snapshot.wstgUnplanned).toBe(2);
    expect(snapshot.wstgSamples).toHaveLength(2);
    expect(snapshot.untriagedGaps).toBe(1);
    expect(situationLine(snapshot)).toBe('Situation: 0 open · breadth: 68 unplanned assets, 2 WSTG questions, 1 untriaged gap.');
    // The line is still hard-capped, and a zero count renders no breadth segment at all.
    expect(situationLine(snapshot).length).toBeLessThanOrEqual(SITUATION_LIMIT);
    expect(situationSegments(summarizeSituation({ tasks: [], cases: [], coverage: [], claims: [] })).map(segment => segment.id)).toEqual(['stall']);
  });

  it('derives the unmet-need samples from the same claim join the chain segment counts', () => {
    const needs = claim('rec-needs', { needs: [{ kind: 'data.read' }] });
    const snapshot = summarizeSituation({ tasks: [], cases: [], coverage: [], claims: [needs] as never });
    expect(snapshot.unmetNeeds).toBe(1);
    expect(snapshot.unmetNeedSamples).toEqual(['data.read <- rec-needs']);
  });

  it('renders the brief section with exact counts, three samples and the disposition rule', () => {
    const brief = buildRoundBrief({
      completion: deriveCompletion({ plans: [], claims: [], tasks: [] }), plans: [], claims: [], tasks: [],
      breadth: {
        unplannedAssets: { count: 68, samples: ['s1', 's2', 's3', 's4', 's5'] },
        wstgUnplanned: { count: 2, samples: ['wstg-athz-04', 'wstg-sess-05'] },
        unmetNeeds: { count: 1, samples: ['cred.session <- rec-b'] },
        untriagedGaps: { count: 1, samples: ['gap-1'] },
      },
      round: { number: 1 },
    });
    expect(brief.text).toContain('## Unplanned work');
    expect(brief.text).toContain('- Unplanned assets (no coverage cell): 68; s1, s2, s3, ... (+2).');
    expect(brief.text).not.toContain('s4');
    expect(brief.text).toContain('- Uncovered WSTG questions (recorded feature applies, no live cell): 2; wstg-athz-04, wstg-sess-05.');
    expect(brief.text).toContain('- Unmet capability needs (nothing demonstrated gains them): 1; cred.session <- rec-b.');
    expect(brief.text).toContain('- Untriaged gaps (no coverage cell or case cites them): 1; gap-1.');
    expect(brief.text).toContain('Disposition per row: revise the coverage plan, create the intent whose question asks it, or record why it is out of scope.');
    expect(brief.sections.find(section => section.id === 'breadth')!.bytes).toBeLessThanOrEqual(ROUND_BRIEF_SECTION_CAPS.breadth);
    expect(brief.bytes).toBeLessThanOrEqual(ROUND_BRIEF_MAX_BYTES);
  });

  it('says the projection is unknown, not zero, when the caller supplied none, and renders nothing when every row is zero', () => {
    const empty = buildRoundBrief({ completion: deriveCompletion({ plans: [], claims: [], tasks: [] }), plans: [], claims: [], tasks: [], round: { number: 1 } });
    expect(empty.text).toContain('unplanned work is unknown, not zero');
    const zeroed = buildRoundBrief({ completion: deriveCompletion({ plans: [], claims: [], tasks: [] }), plans: [], claims: [], tasks: [], round: { number: 1 },
      breadth: { unplannedAssets: { count: 0 }, wstgUnplanned: { count: 0 }, unmetNeeds: { count: 0 }, untriagedGaps: { count: 0 } } });
    expect(zeroed.text).toContain('Breadth: no unplanned asset, uncovered WSTG question, untriaged gap or unmet capability need is recorded.');
    expect(zeroed.text).not.toContain('Disposition per row');
  });
});

describe('chain frontier and dispatch breadth (P21/C6)', () => {
  it('renders the waiting frontier with unmet capability needs beside the ready step it cannot take', () => {
    const plans = [
      plan({ id: 'step-1', kind: 'todo', status: 'done', title: 'Map the fixture surface', chainOf: 'chain-x', step: 1, claimRefs: ['rec-a'], route: 'auth' }),
      plan({ id: 'step-2', kind: 'todo', status: 'open', title: 'Read the fixture object', chainOf: 'chain-x', step: 2, claimRefs: ['rec-b'], needs: [{ kind: 'data.read' }], route: 'auth' }),
    ];
    const claims = [
      claim('rec-a', { closure: 'confirmed', execution: 'tested', gained: [{ kind: 'http.request' }] }),
      claim('rec-b', { needs: [{ kind: 'data.read' }] }),
    ];
    const brief = buildRoundBrief({ completion: deriveCompletion({ plans, claims, tasks: [] }), plans, claims, tasks: [], round: { number: 1 } });
    expect(brief.text).toContain('Waiting chain steps: 1.');
    expect(brief.text).toContain('waits on data.read');
    expect(brief.text).toContain('Unmet capability needs: 1 open claim(s) need a capability nothing demonstrated gains (rec-b needs data.read).');
    expect(brief.text).toContain('plan the capability task the need names');
    // The situation line renders both frontier counters from the same plan board the brief read.
    const line = situationLine(summarizeSituation({ tasks: [], cases: [], coverage: [], claims: claims as never, plans }));
    expect(line).toContain('chain: 0 steps ready, 1 waiting, 1 unmet needs');
  });

  it('pins the breadth, capability-need and batch guidance in the planner prompt', () => {
    const text = plannerInstructions(baseFacts);
    expect(text).toContain('BREADTH BEFORE IDLE');
    expect(text).toContain('revise the coverage plan, create the intent whose questionKey asks it, or record the exclusion');
    expect(text).toContain('CAPABILITY NEEDS');
    expect(text).toContain('`needs: cred.secret`');
    expect(text).toContain('shared:recording');
    expect(text).toContain('several independent tasks per round (the host accepts up to 25)');
    expect(text).not.toMatch(/\bp2o_[a-z_]+\b/);
  });

  it('admits a batch of independent tasks in one dispatch call instead of one question per call', async () => {
    await fixture(async h => {
      await h.command('--target ./source');
      await seedImpactGoal(h);
      const draft = (surface: string) => ({ question: `Inspect the breadth fixture at ${surface}`, surface, risk: 'fixture', role: 'general',
        roleReason: 'Bounded controlled fixture observation', expectedTrue: 'Receipt supports this particular observation', expectedFalse: 'Receipt refutes this particular observation',
        stopCondition: 'Stop after the bounded observation or missing prerequisite', evidenceIds: [], prerequisites: [], skills: [], methodReason: 'Controlled inert fixture; not security proof' });
      const ids: string[] = [];
      for (const surface of ['/breadth-a', '/breadth-b', '/breadth-c']) ids.push((await h.call('p2o_task_author', { entry: draft(surface) })).details.id);
      const dispatched = (await h.call('p2o_task_dispatch', { ids })).details;
      expect(dispatched.pendingIntents).toBe(3);
    });
  });
});

describe('coverage revision demand and question queue (P21/C2/C3)', () => {
  it('names the revision a discovery backlog owes and ignores closed or cancelled plans', () => {
    expect(coverageRevisionDemand([{ status: 'active', discoveredUnplannedAssets: 68 }]))
      .toBe('the coverage plan owes a revision for 68 unplanned assets — revise it or record the exclusion');
    expect(coverageRevisionDemand([{ status: 'active', discoveredUnplannedAssets: 1 }])).toContain('for 1 unplanned asset ');
    expect(coverageRevisionDemand([{ status: 'closed', discoveredUnplannedAssets: 4 }, { status: 'cancelled', discoveredUnplannedAssets: 5 }])).toBeUndefined();
    expect(coverageRevisionDemand([])).toBeUndefined();
  });

  it('builds a bounded, deduped per-asset question queue whose keys are valid questionKey values', () => {
    const assets = [{ assetId: 'asset-a', features: ['login'] }, { assetId: 'asset-b', features: ['api'] }];
    const { queue, omitted } = wstgQuestionQueue(assets, { covered: new Set(), planId: 'coverage-1' });
    expect(queue.length).toBeGreaterThan(0);
    expect(queue.length).toBeLessThanOrEqual(20);
    expect(omitted).toBeGreaterThan(0);
    expect(new Set(queue.map(item => `${item.assetId}|${item.questionKey}`)).size).toBe(queue.length);
    for (const item of queue) {
      expect(isWstgKey(item.questionKey), item.questionKey).toBe(true);
      expect(item.expectedObservation.length).toBeGreaterThan(0);
      expect(item.planId).toBe('coverage-1');
      expect(['asset-a', 'asset-b']).toContain(item.assetId);
    }
    // A covered key is not offered again, and the limit bounds the page while `omitted` keeps the true remainder.
    const first = queue[0];
    const covered = wstgQuestionQueue(assets, { covered: new Set([first.questionKey]) });
    expect(covered.queue.some(item => item.questionKey === first.questionKey)).toBe(false);
    expect(wstgQuestionQueue(assets, { covered: new Set(), limit: 0 })).toEqual({ queue: [], omitted: expect.any(Number) });
    expect(wstgQuestionQueue([], { covered: new Set() })).toEqual({ queue: [], omitted: 0 });
  });

  it('dispatches nothing and derives no cell from a suggestion or queue read', async () => {
    await fixture(async h => {
      await h.command('--target ./source');
      await h.call('p2o_graph_record', { batch: { assets: [{ asset: { kind: 'endpoint', key: 'POST /queue-login', attributes: { feature: 'login' } } }] } });
      const denominator = (await h.call('p2o_coverage_plan', { plan: { title: 'Queue fixture denominator', status: 'active', reason: 'Fixture plan the queue read must not extend', exclusions: [], unknownScope: [] } })).details;
      const before = await h.reader();
      const count = before.records().length;
      before.close();
      const result = (await h.call('p2o_wstg_suggest', { limit: 1 })).details;
      expect(result.queue.length).toBeGreaterThan(0);
      expect(result.queue.every((item: any) => item.planId === denominator.id)).toBe(true);
      expect(result.queueNote).toMatch(/never a finding, permission, coverage or a cell/);
      const after = await h.reader();
      try { expect(after.records().length).toBe(count); } finally { after.close(); }
      // The plan the queue names still has no derived cell: the read asked for a question to plan, not a denominator entry.
      const view = (await h.call('p2o_board', { board: 'coverage', id: denominator.id })).details;
      expect(view.cells).toEqual([]);
    });
  });
});
