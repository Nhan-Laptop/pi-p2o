import type { ViewProfile } from './state.js';
import type { CaseView } from '../cases.js';
import type { reportProjection } from '../report.js';
import { safeText } from '../evidence.js';

export type ReportView = ReturnType<typeof reportProjection>;

const safe = (text: string, limit = 200) => safeText(text).replace(/\s+/g, ' ').slice(0, limit);

/**
 * Pure, read-only summary lines for the progress widget: queue/target-operation pressure, coverage execution/assessment
 * breakdown and case-rating severity — facts that already exist in host state (ExecutorPool.snapshot, AssessmentEngine.snapshot,
 * CoverageCellEntry axes, CaseView.finding) but were never surfaced. No tool, no authority, no write path.
 */
export function dashboardLines(profile: ViewProfile, report: ReportView, cases: CaseView[]): string[] {
  const events = profile.engine.pendingEvents;
  const running = profile.executor.runningTargetOperations, waiting = profile.executor.waitingTargetOperations;
  const queue = `Queue: ${profile.engine.pendingIntents} accepted intent(s), ${events === undefined ? 'events unknown' : `${events} pending event(s)`} | target-ops: ${running === undefined ? 'running unknown' : `running ${running}`}/${waiting === undefined ? 'waiting unknown' : `waiting ${waiting}`} (cap ${profile.executor.maxTargetOperations})`;

  let coverage: string;
  if (!report.counts.coveragePlans) {
    coverage = 'Coverage: no plan recorded yet';
  } else {
    // report.coveragePlans may be truncated by the shared byte budget; counts.coveragePlans/coverageCells/staleCoverageCells
    // are exact totals computed before truncation, so only the execution/assessment breakdown needs the completeness check.
    const complete = report.coveragePlans.length === report.counts.coveragePlans;
    const tested = complete ? report.coveragePlans.reduce((sum, plan) => sum + (plan.counts.execution.tested ?? 0), 0) : undefined;
    const openGaps = complete ? report.coveragePlans.reduce((sum, plan) => sum + (plan.counts.assessment.open_gap ?? 0), 0) : undefined;
    coverage = `Coverage: ${report.counts.coveragePlans} plan(s), ${report.counts.coverageCells} cell(s)${tested === undefined ? '' : ` (tested ${tested}, open-gap ${openGaps})`}; stale ${report.counts.staleCoverageCells}${complete ? '' : ' (breakdown unavailable — truncated projection)'}`;
  }

  // acceptedFinding entries are canonical by construction (duplicates fail the check), so no further dedup is needed.
  const accepted = cases.filter(c => c.acceptedFinding);
  let casesLine: string;
  if (!accepted.length) {
    casesLine = `Cases: accepted-current 0 | pending ${report.counts.pendingCaseReviews}, stale ${report.counts.staleCases}`;
  } else {
    const bySeverity = new Map<string, number>(); let unrated = 0, ratingStale = 0;
    for (const entry of accepted) {
      if (!entry.finding) { unrated += 1; continue; }
      bySeverity.set(entry.finding.severity, (bySeverity.get(entry.finding.severity) ?? 0) + 1);
      if (entry.ratingCurrent === false) ratingStale += 1;
    }
    const severityText = [...bySeverity].map(([severity, count]) => `${severity} ${count}`).join(', ');
    casesLine = `Cases: accepted-current ${accepted.length}${severityText ? ` (${severityText})` : ''}${unrated ? `, unrated ${unrated}` : ''}${ratingStale ? `, rating-stale ${ratingStale}` : ''} | pending ${report.counts.pendingCaseReviews}, stale ${report.counts.staleCases}`;
  }

  return [queue, coverage, casesLine].map(line => safe(line, 300));
}
