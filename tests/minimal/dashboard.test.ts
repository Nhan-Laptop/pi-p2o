import { describe, expect, it } from 'vitest';
import { dashboardLines, type ReportView } from '../../src/ui/dashboard.js';
import type { ViewProfile } from '../../src/ui/state.js';
import type { CaseView } from '../../src/cases.js';

const profile = (overrides: Partial<ViewProfile['engine']> = {}, executor: Partial<ViewProfile['executor']> = {}): ViewProfile => ({
  runId: 'run-x', target: 'fixture', lifecycle: 'active', delegation: true, maxWorkers: 3, exportEnabled: false,
  engine: { mode: 'manual', pendingIntents: 2, pendingEvents: 1, rounds: 0, maxAutomaticRounds: 100, paused: undefined, decision: undefined, ...overrides } as ViewProfile['engine'],
  executor: { mode: 'shared', maxTargetOperations: 2, runningTargetOperations: 1, waitingTargetOperations: 0, ...executor },
});

const report = (overrides: Partial<ReportView['counts']> = {}, coveragePlans: ReportView['coveragePlans'] = []): ReportView => ({
  counts: { coveragePlans: 0, coverageCells: 0, staleCoverageCells: 0, pendingCaseReviews: 0, staleCases: 0, ...overrides },
  coveragePlans,
} as ReportView);

const acceptedCase = (over: Partial<CaseView> = {}): CaseView => ({
  id: 'case-1', recordId: 'r1', runId: 'run-x', revision: 1, title: 'x', policyKey: 'p', assetRefs: [], claimRefs: [], independentEvidenceRefs: [],
  taskRefs: [], reportRefs: [], contradictions: [], affectedVariants: [], relatedCaseIds: [], verdict: 'confirmed', reviewStatus: 'accepted',
  remediation: { status: 'unplanned', reason: '', evidenceRefs: [] }, limitations: '', currentness: 'current', staleReasons: [],
  independentCurrent: true, acceptedFinding: true, canonicalCaseId: 'case-1', ...over,
} as unknown as CaseView);

describe('dashboardLines (pure view model)', () => {
  it('shows unknown, not 0, when the engine/executor fields are absent from the snapshot', () => {
    const p = profile({ pendingEvents: undefined }, { runningTargetOperations: undefined, waitingTargetOperations: undefined });
    const [queue] = dashboardLines(p, report(), []);
    expect(queue).toContain('events unknown');
    expect(queue).toContain('running unknown');
    expect(queue).toContain('waiting unknown');
    expect(queue).not.toContain(' 0 pending event');
  });

  it('reports queue depth and target-operation pressure when known', () => {
    const [queue] = dashboardLines(profile(), report(), []);
    expect(queue).toBe('Queue: 2 accepted intent(s), 1 pending event(s) | target-ops: running 1/waiting 0 (cap 2)');
  });

  it('says no plan recorded yet when there is no coverage plan', () => {
    const [, coverage] = dashboardLines(profile(), report(), []);
    expect(coverage).toBe('Coverage: no plan recorded yet');
  });

  it('aggregates the execution/assessment histogram across plans when the projection is complete', () => {
    const rep = report({ coveragePlans: 2, coverageCells: 5, staleCoverageCells: 1 }, [
      { counts: { execution: { tested: 2, blocked: 1 }, assessment: { open_gap: 1, accepted: 1 } } },
      { counts: { execution: { tested: 1 }, assessment: { accepted: 1 } } },
    ] as unknown as ReportView['coveragePlans']);
    const [, coverage] = dashboardLines(profile(), rep, []);
    expect(coverage).toBe('Coverage: 2 plan(s), 5 cell(s) (tested 3, open-gap 1); stale 1');
  });

  it('drops the breakdown and says so when the coverage projection was truncated', () => {
    const rep = report({ coveragePlans: 2, coverageCells: 5, staleCoverageCells: 1 }, [
      { counts: { execution: { tested: 2 }, assessment: { accepted: 2 } } },
    ] as unknown as ReportView['coveragePlans']); // only 1 of 2 plans shown
    const [, coverage] = dashboardLines(profile(), rep, []);
    expect(coverage).toBe('Coverage: 2 plan(s), 5 cell(s); stale 1 (breakdown unavailable — truncated projection)');
  });

  it('counts zero accepted-current findings without inventing a severity', () => {
    const [, , cases] = dashboardLines(profile(), report({ pendingCaseReviews: 2, staleCases: 1 }), []);
    expect(cases).toBe('Cases: accepted-current 0 | pending 2, stale 1');
  });

  it('buckets accepted-current findings by rated severity, and flags unrated and stale-rated ones separately', () => {
    const cases = [acceptedCase({ id: 'a', finding: { severity: 'critical', basis: '', cwe: [], references: [], reproductionEvidenceRefs: [] }, ratingCurrent: true }),
      acceptedCase({ id: 'b', finding: { severity: 'critical', basis: '', cwe: [], references: [], reproductionEvidenceRefs: [] }, ratingCurrent: false }),
      acceptedCase({ id: 'c' })]; // no rating at all
    const [, , line] = dashboardLines(profile(), report({ pendingCaseReviews: 1, staleCases: 0 }), cases);
    expect(line).toBe('Cases: accepted-current 3 (critical 2), unrated 1, rating-stale 1 | pending 1, stale 0');
  });
});
