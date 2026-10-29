import { describe, expect, it } from 'vitest';
import {
  ROUND_BRIEF_MAX_BYTES, ROUND_BRIEF_SECTION_CAPS, ROUND_DIGEST_MAX_BYTES,
  buildRoundBrief, buildRoundDigest,
  type BriefCampaign, type BriefCase, type BriefCoveragePlan, type BriefProgress, type BriefRevisit,
  type BriefGraphDelta, type BriefLearned, type BriefLearnedClaim, type BriefWorker, type RoundBriefInput,
} from '../../src/round-brief.js';
import { completionLine, deriveCompletion } from '../../src/completion.js';
import { DEBT_KINDS, SIGNAL_KINDS, debtFor, type DebtItem, type DebtKind, type DebtReport } from '../../src/debt.js';
import { DEFAULT_ROUND_BUDGET } from '../../src/round-budget.js';
import type { ChainClaim } from '../../src/chain-view.js';
import type { PlanEntry } from '../../src/planning.js';
import type { SituationSnapshot } from '../../src/situation.js';
import type { AssessmentTask } from '../../src/tasks.js';

/**
 * P18.2/D46: the briefing is a pure projection of the round's own reads. These tests pin the sections on a fixture ledger,
 * the honest empty-ledger text, every byte cap, the absence of invented target prose, and that `remaining` is the same
 * number `deriveCompletion` produces — the brief has no second derivation.
 */
const claim = (recordId: string, overrides: Partial<ChainClaim> = {}): ChainClaim => ({
  candidate: recordId, recordId, closure: 'open_proof_gap', execution: 'not_tested', surface: '/fixture', ...overrides,
});

type PlanSeed = Pick<PlanEntry, 'id' | 'kind' | 'title' | 'status'> & Partial<PlanEntry>;
const plan = (seed: PlanSeed): PlanEntry => ({
  runId: 'run-1', revision: 1, recordId: `record-${seed.id}`, reason: 'fixture row recorded for the round-brief test', ...seed,
});

const task = (id: string, status: string, extra: Partial<AssessmentTask> = {}): AssessmentTask => ({
  id, runId: 'run-1', revision: 1, recordId: `record-task-${id}`, question: `fixture question ${id}`,
  surface: '/fixture', risk: 'fixture risk', role: 'recon', roleReason: 'fixture role reason',
  expectedTrue: 'fixture expected true', expectedFalse: 'fixture expected false', stopCondition: 'fixture stop condition',
  evidenceIds: [], prerequisites: [], method: { skills: [], reason: 'fixture method reason' },
  status: status as AssessmentTask['status'], ...extra,
} as AssessmentTask);

const debtReport = (items: readonly DebtItem[]): DebtReport => {
  const totals = Object.fromEntries(DEBT_KINDS.map(kind => [kind, 0])) as Record<DebtKind, number>;
  for (const item of items) totals[item.kind] += 1;
  return { items: [...items], ids: items.map(item => item.id), gateableIds: items.filter(item => item.gateable).map(item => item.id),
    totals, total: items.length, gateable: items.filter(item => item.gateable).length,
    backlog: items.filter(item => SIGNAL_KINDS.includes(item.kind)).length, discharged: 0 };
};

const situation: SituationSnapshot = {
  open: 2, running: 1, runningRoles: ['validation'], ready: 1, exhausted: 0, blocked: 0, openContradictions: 0,
  chainReady: 1, chainUnmet: 0, chainSteps: 1, chainReadySteps: 1, chainWaitingSteps: 0, pendingRating: 1,
  replayableClaims: 0, derivedEdges: 0, validationCurrent: 0, unmetNeeds: 0,
  coverageTested: 1, coverageCells: 3, coveragePlanned: 1, coverageOmitted: 2, leadsUntriaged: 0, leadsCritical: 0,
  routesOpen: 1, routesDone: 0, routeNames: ['auth'], unprovenNegations: 0, suggested: { purpose: 'validation', score: 65 },
};

const digestRecords = [
  { at: '2026-10-28T09:00:00.000Z', by: 'worker-a', kind: 'note', text: 'mapped the export endpoint' },
  { at: '2026-10-28T09:10:00.000Z', by: 'worker-a', kind: 'evidence', text: 'export receipt captured' },
  { at: '2026-10-28T09:20:00.000Z', by: 'owner', kind: 'task', text: 'reviewed the mapping task' },
  { at: '2026-10-28T09:30:00.000Z', by: 'owner', kind: 'plan', text: 'recorded step 2 of chain-export' },
  { at: '2026-10-28T09:40:00.000Z', by: 'worker-b', kind: 'candidate', text: 'claim rec-b needs http.request' },
];

/** One balanced ledger: an open goal, one ready chain step, one unchained primitive, all three review queues, debt and a digest. */
function fixture(overrides: Partial<RoundBriefInput> = {}): RoundBriefInput {
  const plans: PlanEntry[] = [
    plan({ id: 'goal-export', kind: 'goal', status: 'active', title: 'Confirm the invoice export boundary',
      criteria: ['The export path is bounded to the recorded tenant'],
      proof: { kind: 'capability', capability: { kind: 'data.read', subject: 'invoice-export' } } }),
    plan({ id: 'step-1', kind: 'todo', status: 'done', title: 'Map the export endpoint', chainOf: 'chain-export', step: 1, claimRefs: ['rec-a'], route: 'auth' }),
    plan({ id: 'step-2', kind: 'todo', status: 'open', title: 'Take the export read one step further', chainOf: 'chain-export', step: 2,
      claimRefs: ['rec-b'], needs: [{ kind: 'http.request' }], route: 'auth' }),
    plan({ id: 'wall-rec-d', kind: 'todo', status: 'blocked', title: 'Wall the login session primitive', claimRefs: ['rec-d'], route: 'auth' }),
  ];
  const claims: ChainClaim[] = [
    claim('rec-a', { closure: 'confirmed', execution: 'tested', gained: [{ kind: 'http.request' }], surface: '/api/export' }),
    claim('rec-b', { needs: [{ kind: 'http.request' }], surface: '/api/export' }),
    claim('rec-c', { closure: 'confirmed', execution: 'tested', gained: [{ kind: 'exec.code' }], surface: '/admin/export' }),
    claim('rec-d', { closure: 'confirmed', execution: 'tested', gained: [{ kind: 'cred.session' }], surface: '/login' }),
  ];
  const tasks = [task('t-1', 'reported'), task('t-2', 'running'), task('t-3', 'closed')];
  const cases: BriefCase[] = [{ id: 'case-1', reviewStatus: 'pending', verdict: 'open', currentness: 'current', claimRefs: ['rec-c'] }];
  const coverage: BriefCoveragePlan[] = [{
    id: 'coverage-1',
    cells: [
      { id: 'cell-1', effectiveExecution: 'tested', effectiveAssessment: 'confirmed_claim', currentness: 'current' },
      { id: 'cell-2', effectiveExecution: 'planned', effectiveAssessment: 'unreviewed', currentness: 'current' },
      { id: 'cell-3', effectiveExecution: 'attempted', effectiveAssessment: 'open_gap', currentness: 'stale' },
    ],
    omittedCells: 2, discoveredUnplannedAssets: 1, unmappedCount: 1,
  }];
  const debt = debtReport([
    { id: 'debt-cell-not-run-aaaaaaaaaaaa', kind: 'CELL_NOT_RUN', subject: 'cell-2', detail: 'planned and unreviewed', gateable: false },
    { id: 'debt-gap-untriaged-bbbbbbbbbbbb', kind: 'GAP_UNTRIAGED', subject: 'gap-1', detail: 'no cell or case references it', gateable: true },
  ]);
  const workers: BriefWorker[] = [
    { id: 'worker-a', role: 'recon', state: 'reported', commandsUsed: 14, reported: true },
    { id: 'worker-b', role: 'validation', state: 'running', commandsUsed: 3, quiet: true, taskId: 't-2' },
    { id: 'worker-c', role: 'recon', state: 'cancelled', stopped: true },
  ];
  const revisits: BriefRevisit[] = [{ condition: 'block-decay', at: '2026-10-28T12:00:00.000Z' }];
  const progress: BriefProgress = { closures: 2, testedCells: 1, assets: 1, chainDepth: 1, remaining: 4, debt: { gateable: 1, total: 2 } };
  const previous: BriefProgress = { closures: 1, testedCells: 0, assets: 1, chainDepth: 0, remaining: 6, debt: { gateable: 1, total: 3 } };
  const campaign: BriefCampaign = {
    objective: 'Assess the invoice export API for tenant-boundary mistakes',
    constraints: [{ rule: 'deny', text: 'no availability-loss effects' }, { rule: 'allow', text: 'read-only replay of the export endpoint' }],
    mode: 'exploit',
  };
  const completion = deriveCompletion({ plans, claims, tasks, cases, debt: debtFor(debt),
    coverage: coverage.map(view => ({ planId: view.id, cells: view.cells.map(cell => ({ id: cell.id, execution: cell.effectiveExecution })) })) });
  return {
    campaign, completion, plans, claims, tasks, cases, coverage, debt, workers, revisits, progress, previous,
    digest: buildRoundDigest(digestRecords, 3), situation,
    round: { number: 2, model: 'test/model-a', facts: { steps: 5, startedAt: 0, now: 60_000, contextPercent: 41, budget: { ...DEFAULT_ROUND_BUDGET } } },
    ...overrides,
  };
}

const emptyFixture = (): RoundBriefInput => ({
  completion: deriveCompletion({ plans: [], claims: [], tasks: [] }), plans: [], claims: [], tasks: [],
  round: { number: 1, model: 'test/model-a', facts: { steps: 0, startedAt: 0, now: 0, budget: { ...DEFAULT_ROUND_BUDGET } } },
});

/** Every section near its cap: a long campaign frame, many goals/steps/claims, queues, workers and folded history. */
function denseFixture(): RoundBriefInput {
  const base = fixture();
  const claims: ChainClaim[] = [], plans: PlanEntry[] = [];
  for (let index = 0; index < 40; index++) {
    const provider = `rec-provider-${index}`, consumer = `rec-consumer-${index}`;
    claims.push(claim(provider, { closure: 'confirmed', execution: 'tested', gained: [{ kind: 'http.request' }], surface: `/surface-${index}` }));
    claims.push(claim(consumer, { needs: [{ kind: 'http.request' }], surface: `/surface-${index}` }));
    plans.push(plan({ id: `step-a-${index}`, kind: 'todo', status: 'done', title: `Provider step ${index} ${'long title '.repeat(8)}`, chainOf: `chain-${index}`, step: 1, claimRefs: [provider], route: 'auth' }));
    plans.push(plan({ id: `step-b-${index}`, kind: 'todo', status: 'open', title: `Consumer step ${index} ${'long title '.repeat(8)}`, chainOf: `chain-${index}`, step: 2, claimRefs: [consumer], needs: [{ kind: 'http.request' }], route: 'auth' }));
    claims.push(claim(`rec-unchained-${index}`, { closure: 'confirmed', execution: 'tested', gained: [{ kind: 'exec.code' }], surface: `/admin/${index}` }));
    plans.push(plan({ id: `goal-${index}`, kind: 'goal', status: 'active', title: `Dense goal ${index} ${'x'.repeat(300)}`,
      criteria: ['A bounded criterion'], proof: { kind: 'capability', capability: { kind: 'data.read', subject: `subject-${index}` } } }));
  }
  const tasks = Array.from({ length: 30 }, (_, index) => task(`dense-task-${index}`, 'reported'));
  const cases: BriefCase[] = Array.from({ length: 30 }, (_, index) => ({ id: `dense-case-${index}`, reviewStatus: 'pending', verdict: 'open', currentness: 'current', claimRefs: [] }));
  const workers: BriefWorker[] = Array.from({ length: 40 }, (_, index) => ({
    id: `dense-worker-${index}`, role: 'recon', state: index % 2 ? 'running' : 'reported', commandsUsed: index,
    quiet: index % 2 === 1, reported: index % 2 === 0,
  }));
  const revisits: BriefRevisit[] = Array.from({ length: 12 }, (_, index) => ({ condition: `condition-${index}`, at: `2026-10-28T12:${String(index).padStart(2, '0')}:00.000Z` }));
  const coverage: BriefCoveragePlan[] = [{
    id: 'dense-coverage',
    cells: Array.from({ length: 60 }, (_, index) => ({
      id: `dense-cell-${index}`, effectiveExecution: index % 3 === 0 ? 'tested' : 'planned',
      effectiveAssessment: 'open_gap', currentness: 'current',
    })),
    omittedCells: 10, discoveredUnplannedAssets: 4, unmappedCount: 3,
  }];
  const debt = debtReport(Array.from({ length: 8 }, (_, index) => ({
    id: `debt-cell-not-run-${String(index).padStart(12, '0')}`, kind: 'CELL_NOT_RUN' as const,
    subject: `dense subject ${index} ${'s'.repeat(180)}`, detail: 'derived fixture debt', gateable: false,
  })));
  const campaign: BriefCampaign = {
    ...base.campaign!,
    constraints: Array.from({ length: 12 }, (_, index) => ({ rule: 'deny' as const, text: `constraint ${index} ${'z'.repeat(280)}` })),
  };
  const records = Array.from({ length: 200 }, (_, index) => ({
    at: `2026-10-28T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`,
    by: `worker-${index % 7}`, kind: index % 2 ? 'note' : 'evidence', text: `folded record ${index} ${'detail '.repeat(20)}`,
  }));
  const completion = deriveCompletion({ plans, claims, tasks, cases, debt: debtFor(debt),
    coverage: coverage.map(view => ({ planId: view.id, cells: view.cells.map(cell => ({ id: cell.id, execution: cell.effectiveExecution })) })) });
  return { ...base, campaign, plans, claims, tasks, cases, coverage, debt, workers, revisits, completion,
    digest: buildRoundDigest(records, 150), progress: { ...base.progress!, remaining: completion.remaining } };
}

const GOLDEN_BRIEF = `P2O round brief: round 2
Situation: 1 running (validation) · 1 ready · next: validation 65 · chain: 1 step ready, 0 waiting · routes: 1 open (auth), 0 done · 1 case pending rating · coverage 1/3 (planned 1 unreached, 2 omitted).
## Campaign frame
Objective: Assess the invoice export API for tenant-boundary mistakes
Constraints: deny: no availability-loss effects | allow: read-only replay of the export endpoint
Mode: exploit

## Completion and demand
incomplete: 4 obligation(s) — GOAL_UNSETTLED 1: a goal is not reviewed or closed yet; settlement is a plan revision, not a report; PRIMITIVE_UNCHAINED 1: a confirmed and tested claim has no successor step and no recorded wall; CHAIN_READY 1: a chain step is ready to take and has not been dispatched; RESEARCH_DEBT 1: research debt the host can name is outstanding; a decision row and prose do not discharge it
Demand: 1 goal(s) not reviewed or closed; 1 demonstrated primitive(s) with no successor step; step 2 of chain chain-export ready and undispatched; 1 research debt item(s) with no discharge
Obligations: GOAL_UNSETTLED 1; PRIMITIVE_UNCHAINED 1; CHAIN_READY 1; RESEARCH_DEBT 1

## Goals and proof
Goals: 1.
- goal-export [active] Confirm the invoice export boundary — UNPROVEN: no confirmed and tested claim gains data.read (invoice-export); a goal is settled by a demonstrated primitive, not by notes

## Ready chain steps
Ready chain steps: 1.
- chain chain-export step 2: Take the export read one step further — consumes http.request already gained by rec-a on /api/export

## Unchained primitives
Unchained primitives: 1.
- claim rec-c gains exec.code on /admin/export — no successor step and no recorded wall

## Coverage and route
Coverage: 1/3 cell(s) tested; unreached 1; attempted 1; stale 1; open-gap assessments 1.
Denominator backlog: 2 omitted cell(s); 1 discovered unplanned asset(s); 1 unmapped task(s).
Gaps: 1 untriaged open gap(s) named by research debt.
Route monoculture hint: every open step is on route auth; plausible elsewhere: business-logic, deser, injection, path, sqli. A hint only; the lead decides scope.

## Awaiting review
Tasks awaiting review: 1; t-1.
Confirmed claims with no case: 2; rec-a, rec-d.
Cases pending or disputed: 1; case-1.

## Workers
Workers: 3 total; 1 live (1 quiet); 1 reported; 1 stopped.
- worker-a recon [reported] 14 cmds
- worker-b validation [running] task t-2 3 cmds QUIET
- worker-c recon [cancelled] stopped

## Delta since the last round
Since the last round: closures 1->2 (+1); tested cells 0->1 (+1); assets 1 (no change); chain depth 0->1 (+1); remaining 6->4 (-2); debt (gateable) 1 (no change).

## Learned this round
No learned projection was supplied this round; what the run recorded is unknown, not zero.

## Research debt
1 research debt item(s): GAP_UNTRIAGED 1; planning signal (not owed work): CELL_NOT_RUN 1
- debt-cell-not-run-aaaaaaaaaaaa CELL_NOT_RUN: cell-2
- debt-gap-untriaged-bbbbbbbbbbbb GAP_UNTRIAGED: gap-1 — discharge: cite the gap from a coverage cell or a case, or wall it in a deferred todo stating why it stays open
Citable debt ids: debt-gap-untriaged-bbbbbbbbbbbb.
A deferred/blocked todo citing these ids is the wall; a round that records one is progress, not a stall.

## Revisit conditions
Revisits: 1.
- block-decay at 2026-10-28T12:00:00.000Z

## Round facts
Round: 2 of an uncapped campaign.
Model: test/model-a.
Budget: 40 steps / 900s / context 80% wrap, 92% hard.
State: open; steps 5/40; context 41%.

## Older material
Folded 3 older record(s); window starts at 3, 2 kept.
Kinds: evidence 1, note 1, task 1. Actors: 2.
Span: 2026-10-28T09:00:00.000Z .. 2026-10-28T09:20:00.000Z.
- note by worker-a: mapped the export endpoint
- evidence by worker-a: export receipt captured
- task by owner: reviewed the mapping task`;

describe('round brief (P18.2/D46)', () => {
  it('renders every D46 section from the same read the engine consumed', () => {
    const input = fixture();
    const brief = buildRoundBrief(input);
    expect(brief.sections.map(section => section.id)).toEqual([
      'frame', 'completion', 'goals', 'ready', 'unchained', 'coverage', 'review', 'workers', 'delta', 'learned', 'debt', 'revisits', 'round', 'digest',
    ]);
    expect(brief.remaining).toBe(input.completion.remaining);
    expect(brief.remaining).toBe(deriveCompletion({
      plans: input.plans, claims: input.claims, tasks: input.tasks, cases: input.cases, debt: debtFor(input.debt!),
      coverage: input.coverage!.map(view => ({ planId: view.id, cells: view.cells.map(cell => ({ id: cell.id, execution: cell.effectiveExecution })) })),
    }).remaining);
    expect(brief.text).toContain(completionLine(input.completion));
    expect(brief.text).toContain('Assess the invoice export API');
    expect(brief.text).toContain('goal-export [active] Confirm the invoice export boundary — UNPROVEN:');
    expect(brief.text).toContain('chain chain-export step 2');
    expect(brief.text).toContain('rec-c');
    expect(brief.text).toContain('Coverage: 1/3 cell(s) tested');
    expect(brief.text).toContain('Route monoculture hint: every open step is on route auth');
    expect(brief.text).toContain('rec-d');
    expect(brief.text).toContain('Workers: 3 total; 1 live (1 quiet)');
    expect(brief.text).toContain('Since the last round: closures 1->2 (+1)');
    expect(brief.text).toContain('debt-cell-not-run-aaaaaaaaaaaa');
    expect(brief.text).toContain('block-decay at 2026-10-28T12:00:00.000Z');
    expect(brief.text).toContain('Model: test/model-a');
    expect(brief.text).toContain('Folded 3 older record(s)');
    expect(brief.bytes).toBe(Buffer.byteLength(brief.text, 'utf8'));
    expect(buildRoundBrief(input).text).toBe(brief.text);
    expect(brief.text).toBe(GOLDEN_BRIEF);
  });

  it('folds older records into a digest instead of dropping them silently', () => {
    const digest = buildRoundDigest(digestRecords, 3);
    expect(digest).toMatchObject({ folded: 3, kept: 2, truncated: false, kinds: [{ kind: 'evidence', count: 1 }, { kind: 'note', count: 1 }, { kind: 'task', count: 1 }],
      span: { earliest: '2026-10-28T09:00:00.000Z', latest: '2026-10-28T09:20:00.000Z' } });
    expect(digest.text).toContain('Folded 3 older record(s); window starts at 3, 2 kept.');
    expect(digest.text).toContain('- task by owner: reviewed the mapping task');
    expect(digest.bytes).toBe(Buffer.byteLength(digest.text, 'utf8'));
    // Position boundaries: zero/negative folds nothing, past the end folds everything, and a fraction floors.
    expect(buildRoundDigest(digestRecords, 0)).toMatchObject({ folded: 0, kept: 5 });
    expect(buildRoundDigest(digestRecords, 0).text).toContain('No older records folded; the round window covers all 5 record(s).');
    expect(buildRoundDigest(digestRecords, -4)).toMatchObject({ folded: 0, kept: 5 });
    expect(buildRoundDigest(digestRecords, 99)).toMatchObject({ folded: 5, kept: 0 });
    expect(buildRoundDigest(digestRecords, 2.9)).toMatchObject({ folded: 2, kept: 3 });
    expect(buildRoundDigest([], 0).text).toContain('the ledger is empty');
    const many = Array.from({ length: 300 }, (_, index) => ({ at: `2026-10-28T10:00:${String(index % 60).padStart(2, '0')}.000Z`, by: 'worker-a', kind: `kind-${index}`, text: `long folded text ${index} ${'word '.repeat(40)}` }));
    const capped = buildRoundDigest(many, many.length);
    expect(capped.bytes).toBeLessThanOrEqual(ROUND_DIGEST_MAX_BYTES);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toMatch(/\[\.\.\. truncated \d+ bytes\]/);
    // A capped digest keeps its marker inside the brief, and the brief reports that some material was clipped.
    const digestBrief = buildRoundBrief(fixture({ digest: capped }));
    expect(digestBrief.sections.find(section => section.id === 'digest')).toMatchObject({ truncated: true });
    expect(digestBrief.truncated).toBe(true);
    expect(digestBrief.bytes).toBeLessThanOrEqual(ROUND_BRIEF_MAX_BYTES);
  });

  it('renders an honest bounded brief for an empty ledger', () => {
    const input = emptyFixture();
    const brief = buildRoundBrief(input);
    expect(brief.remaining).toBe(0);
    expect(brief.bytes).toBeLessThanOrEqual(ROUND_BRIEF_MAX_BYTES);
    expect(brief.truncated).toBe(false);
    expect(brief.omitted).toEqual([]);
    expect(brief.sections.every(section => !section.truncated && !section.omitted)).toBe(true);
    expect(brief.text).toContain('P2O round brief: round 1');
    expect(brief.text).toContain('No campaign record on this run');
    expect(brief.text).toContain(completionLine(input.completion));
    expect(brief.text).toContain('No goal recorded on the plan board');
    expect(brief.text).toContain('No chain step is ready.');
    expect(brief.text).toContain('No demonstrated primitive is left unchained.');
    expect(brief.text).toContain('coverage is unknown, not clean');
    expect(brief.text).toContain('No task, confirmed claim or case is awaiting owner review.');
    expect(brief.text).toContain('No worker has been launched');
    expect(brief.text).toContain('No round counters were supplied');
    expect(brief.text).toContain('No research-debt report was supplied; outstanding research is unknown, not zero.');
    expect(brief.text).toContain('No revisit is scheduled.');
    expect(brief.text).toContain('No older material was folded for this round.');
    expect(brief.text).not.toMatch(/https?:\/\//);
    expect(brief.text).not.toMatch(/CVE-\d{4}-\d+/);
  });

  it('caps every section and the whole brief with explicit markers', () => {
    const input = denseFixture();
    const brief = buildRoundBrief(input);
    expect(brief.bytes).toBe(Buffer.byteLength(brief.text, 'utf8'));
    expect(brief.bytes).toBeLessThanOrEqual(ROUND_BRIEF_MAX_BYTES);
    for (const section of brief.sections) expect(section.bytes, section.id).toBeLessThanOrEqual(ROUND_BRIEF_SECTION_CAPS[section.id]);
    expect(brief.sections.filter(section => section.truncated).length).toBeGreaterThan(0);
    expect(brief.text).toMatch(/\[\.\.\. truncated \d+ bytes\]/);
    expect(brief.omitted.length).toBeGreaterThan(0);
    expect(brief.text).toMatch(/\[\.\.\. omitted \d+ section\(s\)/);
    expect(brief.truncated).toBe(true);
    expect(brief.remaining).toBe(input.completion.remaining);
    // A dropped section is reported in the structure, not silently missing from the list.
    expect([...brief.sections.filter(section => section.omitted).map(section => section.id)].sort()).toEqual([...brief.omitted].sort());
    expect(buildRoundBrief(input).text).toBe(brief.text);
  });

  it('never invents target prose: every target-shaped string comes from the supplied read', () => {
    const brief = buildRoundBrief(fixture());
    expect(brief.text).toContain('/admin/export');
    expect(brief.text).toContain('Assess the invoice export API');
    expect(brief.text).not.toMatch(/https?:\/\//);
    expect(brief.text).not.toMatch(/CVE-\d{4}-\d+/);
    expect(brief.text).not.toContain('10.0.0.9');
  });
});

describe('the brief carries the graph delta the round opened on (R1.7)', () => {
  const graph = (overrides: Partial<BriefGraphDelta> = {}): BriefGraphDelta => ({
    since: 42, counts: { newAssets: 2, changedAssets: 1, openHypotheses: 1, inferredRelations: 3 },
    newAssets: [{ kind: 'endpoint', key: '/api/export' }, { kind: 'route', key: '/admin/export' }],
    assetsWithoutClaim: 4, acceptedFindingsByAsset: [{ assetId: 'asset-aaaaaaaaaaaaaaaaaaaaaaaa', findings: 2 }],
    openHypotheses: [{ statement: 'the export route trusts a forwarded tenant header' }], ...overrides,
  });

  it('names the new and changed assets, the unreviewed frontier and the claims that already exist', () => {
    const brief = buildRoundBrief(fixture({ graph: graph() }));
    expect(brief.text).toContain('Graph since 42: 2 new asset(s), 1 changed; 4 with no claim; 1 open hypothesis(es), 3 inferred relation(s) awaiting review.');
    expect(brief.text).toContain('New assets: endpoint /api/export, route /admin/export.');
    expect(brief.text).toContain('Accepted findings on the busiest assets: asset-aaaaaaaaaaaaaaaaaaaaaaaa 2.');
    expect(brief.text).toContain('Open hypotheses: the export route trusts a forwarded tenant header.');
    // It rides in the delta section, so the D46 section list does not change.
    expect(brief.sections.map(section => section.id)).toContain('delta');
    expect(brief.sections.find(section => section.id === 'delta')!.bytes).toBeLessThanOrEqual(ROUND_BRIEF_SECTION_CAPS.delta);
    expect(brief.text).not.toMatch(/https?:\/\//);
  });

  it('prints nothing about the graph when the round supplied no delta, instead of claiming zero movement', () => {
    const brief = buildRoundBrief(fixture());
    expect(brief.text).not.toContain('Graph since');
    expect(brief.text).toContain('Since the last round:');
    expect(buildRoundBrief(fixture({ graph: { since: 0, counts: { newAssets: 0, changedAssets: 0, openHypotheses: 0, inferredRelations: 0 } } })).text)
      .toContain('Graph since 0: 0 new asset(s), 0 changed; assets without a claim unknown; 0 open hypothesis(es), 0 inferred relation(s) awaiting review.');
  });

  it('bounds the graph rows it prints and reports the section cut instead of growing the brief', () => {
    const many = graph({ counts: { newAssets: 9, changedAssets: 1, openHypotheses: 0, inferredRelations: 0 },
      newAssets: Array.from({ length: 9 }, (_, index) => ({ kind: 'endpoint', key: `/busy/${index}` })), acceptedFindingsByAsset: [], openHypotheses: [] });
    const brief = buildRoundBrief(fixture({ graph: many }));
    expect(brief.text).toContain('New assets: endpoint /busy/0, endpoint /busy/1, endpoint /busy/2, ... (+6).'); // three rows, true total kept in the count
    expect(brief.text).not.toContain('/busy/3');
    const busy = graph({ newAssets: Array.from({ length: 9 }, (_, index) => ({ kind: 'endpoint', key: `/busy/${index}/${'x'.repeat(80)}` })),
      acceptedFindingsByAsset: Array.from({ length: 6 }, (_, index) => ({ assetId: `asset-${String(index).padStart(24, '0')}`, findings: index + 1 })),
      openHypotheses: [{ statement: 'h'.repeat(200) }, { statement: 'i'.repeat(200) }] });
    const capped = buildRoundBrief(fixture({ graph: busy }));
    expect(capped.sections.find(item => item.id === 'delta')!.truncated).toBe(true);
    expect(capped.text).toMatch(/\[\.\.\. truncated \d+ bytes\]/);
    expect(capped.bytes).toBeLessThanOrEqual(ROUND_BRIEF_MAX_BYTES);
    expect(buildRoundBrief(fixture({ graph: busy })).text).toBe(capped.text);
  });
});

describe('the brief separates settled-with-debt goals and planning-signal debt (P19/D, P19/E)', () => {
  it('names a blocked goal as settled with debt instead of unproven work', () => {
    const input = fixture();
    const blocked = plan({ id: 'goal-blocked', kind: 'goal', status: 'blocked', title: 'Reach the never-modeled read',
      criteria: ['A confirmed and tested claim gains the never-modeled read'],
      exclusions: ['No fixture actor holds the never-modeled read'],
      proof: { kind: 'capability', capability: { kind: 'data.read', subject: 'never-modeled' } },
      reason: 'The executed branch cannot gain the read; no fixture actor provides it' });
    const brief = buildRoundBrief({ ...input, plans: [...input.plans, blocked] });
    expect(brief.text).toContain('goal-blocked [blocked] Reach the never-modeled read — settled with debt: The executed branch cannot gain the read; no fixture actor provides it');
    expect(brief.text).not.toContain('goal-blocked [blocked] Reach the never-modeled read — UNPROVEN');
  });

  it('names the wall that answers the debt and the discharge sentence for each owed item', () => {
    const input = fixture();
    const brief = buildRoundBrief(input);
    expect(brief.text).toContain('— discharge: cite the gap from a coverage cell or a case, or wall it in a deferred todo stating why it stays open');
    expect(brief.text).toContain('A deferred/blocked todo citing these ids is the wall; a round that records one is progress, not a stall.');
    // The planning-signal item stays visible but does not read as owed work.
    expect(brief.text).toContain('planning signal (not owed work): CELL_NOT_RUN 1');
  });
});


describe('the brief carries what the run just learned (P20/A3, P20/A5)', () => {
  const learned = (overrides: Partial<BriefLearned> = {}): BriefLearned => ({
    since: 12, window: 3,
    claims: [{ recordId: 'record-claim-1', candidate: 'export-claim', closure: 'confirmed', execution: 'tested',
      proof: 'offline_reproduction', taskId: 'task-9', assetIds: ['asset-aaaaaaaaaaaaaaaaaaaaaaaa'] }],
    cases: [{ recordId: 'record-case-1', caseId: 'case-boundary', verdict: 'confirmed', assetIds: ['asset-aaaaaaaaaaaaaaaaaaaaaaaa'] }],
    walls: [{ planId: 'wall-rec-d', recordId: 'record-wall-d', title: 'Wall the primitive', status: 'blocked', debtRefs: ['debt-gap-untriaged-bbbbbbbbbbbb'] }],
    counts: { claims: 2, cases: 1, walls: 1 }, ...overrides,
  });

  it('names a new claim with its source task and pinned asset, and reports shown against the true count', () => {
    const brief = buildRoundBrief(fixture({ learned: learned() }));
    expect(brief.text).toContain('## Learned this round');
    expect(brief.text).toContain('Recorded since ledger position 12 (3 record(s) in the window): 2 claim(s) (showing 1), 1 accepted case(s) (showing 1), 1 wall(s) (showing 1). Background only: never proof, never a coverage cell.');
    expect(brief.text).toContain('- claim record-claim-1 export-claim confirmed/tested, proof offline_reproduction, via task task-9, on asset-aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(brief.text).toContain('- accepted case case-boundary (confirmed) on asset-aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(brief.text).toContain('- wall wall-rec-d [blocked] answers debt-gap-untriaged-bbbbbbbbbbbb');
    expect(brief.text).toContain('Omitted beyond this page: 1 claim(s), 0 case(s), 0 wall(s).');
    const section = brief.sections.find(item => item.id === 'learned')!;
    expect(section.bytes).toBeLessThanOrEqual(ROUND_BRIEF_SECTION_CAPS.learned);
    expect(section.bytes).toBeGreaterThan(0);
    expect(brief.bytes).toBeLessThanOrEqual(ROUND_BRIEF_MAX_BYTES);
    // Nothing in the section is a link, a truth label or an authority claim.
    expect(brief.text).not.toMatch(/https?:\/\//);
  });

  it('renders the prior-run reference as context only, and says the projection is unknown when it was not supplied', () => {
    const withPrior = buildRoundBrief(fixture({ learned: learned({ claims: [], cases: [], walls: [], counts: { claims: 0, cases: 0, walls: 0 },
      priorRun: { runs: 2, covered: 11, leftOpen: 3, stale: 4, neverReached: 37, unknown: 1 } }) }));
    expect(withPrior.text).toContain('Nothing recorded since ledger position 12 (3 record(s) in the window): no claim, accepted case or wall is in the window.');
    expect(withPrior.text).toContain('Prior run (context only, never evidence): 2 run(s); covered 11, left open 3, stale 4, never reached 37, unknown 1.');
    const absent = buildRoundBrief(fixture());
    expect(absent.text).toContain('No learned projection was supplied this round; what the run recorded is unknown, not zero.');
    expect(absent.text).not.toContain('Prior run (context only');
  });

  it('bounds the learned page and marks the cut instead of growing the brief', () => {
    const many: BriefLearnedClaim[] = Array.from({ length: 9 }, (_, index) => ({
      recordId: `record-claim-${index}`, candidate: `candidate ${index} ${'detail '.repeat(14)}`,
      closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', taskId: 'task-9',
      assetIds: ['asset-aaaaaaaaaaaaaaaaaaaaaaaa'],
    }));
    const brief = buildRoundBrief(fixture({ learned: learned({ claims: many, cases: [], walls: [], counts: { claims: 9, cases: 0, walls: 0 } }) }));
    expect(brief.text).toContain('9 claim(s) (showing 5)');
    expect(brief.sections.find(item => item.id === 'learned')!.truncated).toBe(true);
    expect(brief.text).toMatch(/\[\.\.\. truncated \d+ bytes\]/);
    expect(brief.bytes).toBeLessThanOrEqual(ROUND_BRIEF_MAX_BYTES);
    expect(buildRoundBrief(fixture({ learned: learned({ claims: many, cases: [], walls: [], counts: { claims: 9, cases: 0, walls: 0 } }) })).text).toBe(brief.text);
  });
});
