'use client';
/**
 * planning_update.md P5b: the structured report view. Every value here is the bounded facts payload `renderReport` built from the
 * same variables as REPORT.md, passed through as React text (never HTML, never a re-derivation). The sections follow the document's
 * own order and each carries an id so the contents list can scroll to it; the exact-text view of the document remains the authority,
 * and the note under the title says so.
 */
import type { ReactNode } from 'react';
import type { DashboardRunSummary, ReportFacts } from '../lib/model';
import { withAuthHash } from '../lib/auth';
import { clamp, formatTime, plural, reportHref, severityLabel, shortId } from '../lib/format';

export interface ReportFactsScreenProps {
  facts: ReportFacts;
  runs: DashboardRunSummary[];
  currentRunId: string;
}

const sectionId = (name: string) => `facts-${name}`;

const scrollTo = (name: string): void => {
  if (typeof document !== 'undefined') document.getElementById(sectionId(name))?.scrollIntoView({ block: 'start' });
};

const FactsGrid = ({ rows }: { rows: Array<[string, ReactNode]> }) => (
  <dl className="report-facts-grid">
    {rows.map(([label, value]) => (
      <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
    ))}
  </dl>
);

const Chips = ({ items }: { items: Array<{ name: string; count: number }> }) => items.length ? (
  <ul className="fact-chips">
    {items.map(item => <li key={item.name} className="fact-chip">{item.name}<span className="dim"> ×{item.count}</span></li>)}
  </ul>
) : <span className="dim">none recorded</span>;

const OmittedNote = ({ count, one, many }: { count: number; one: string; many?: string }) =>
  count > 0 ? <p className="facts-note">{plural(count, one, many)} omitted by the report bound.</p> : null;

export function ReportFactsScreen({ facts, runs, currentRunId }: ReportFactsScreenProps) {
  const sections = [
    { name: 'overview', title: 'Overview' },
    { name: 'completion', title: 'Completion & remaining work' },
    { name: 'authority', title: 'Authority' },
    { name: 'summary', title: 'Summary' },
    { name: 'findings', title: 'Findings' },
    { name: 'coverage', title: 'Coverage & gaps' },
    { name: 'gaps', title: 'Open gaps' },
    ...(facts.ladder ? [{ name: 'ladder', title: 'Access ladder' }] : []),
    { name: 'limits', title: 'Limits' },
  ];
  const { completion, summary, authority } = facts;

  return (
    <div className="report-workspace">
      <aside className="report-aside" aria-label="report navigation">
        {runs.length > 1 ? (
          <section className="rail-block">
            <h2>run</h2>
            <ul className="run-switch">
              {runs.map(candidate => (
                <li key={candidate.runId}>
                  <a
                    href={withAuthHash(reportHref(candidate.runId))}
                    className={candidate.runId === currentRunId ? 'is-current' : undefined}
                    aria-current={candidate.runId === currentRunId ? 'page' : undefined}
                  >
                    <span className="mono">{shortId(candidate.runId, 18)}</span>
                    <span className="run-target">{candidate.target ? clamp(candidate.target, 28) : candidate.hasFacts ? 'no recorded target' : 'no structured facts'}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="rail-block">
          <h2>contents</h2>
          <ol className="report-toc-list">
            {sections.map(section => (
              <li key={section.name}>
                <button type="button" className="link-button" onClick={() => scrollTo(section.name)}>{section.title}</button>
              </li>
            ))}
          </ol>
        </section>
      </aside>

      <div className="report-main">
        <p className="ledger-note report-facts-intro">
          Structured facts: bounded values derived by the host from the same committed rows as <span className="mono">REPORT.md</span>.
          The exact-text view of the document remains the authority; these cards cannot claim more than it says.
        </p>

        <section id={sectionId('overview')} className="report-facts-section" aria-label="overview">
          <h2>Overview</h2>
          <FactsGrid rows={[
            ['run', <span className="mono">{facts.runId}</span>],
            ['target', facts.target || 'not recorded'],
            ['retention', facts.retention],
            ['as of sequence', facts.asOfSequence],
            ['records', facts.records],
            ['first committed record', formatTime(facts.firstRecordAt)],
            ['last committed record', formatTime(facts.lastRecordAt)],
            ['end reason', facts.endReason ?? 'not recorded'],
            ['runtime', `${facts.runtime.version} · ${facts.runtime.hashPrefix}`],
            ['historical', facts.historical ? 'yes: a historically retained reading' : 'no: a live-record reading'],
          ]} />
        </section>

        <section id={sectionId('completion')} className="report-facts-section" aria-label="completion and remaining work">
          <h2>Completion &amp; remaining work</h2>
          <p className="report-completion-line">{completion.line}</p>
          <FactsGrid rows={[
            ['state', completion.state],
            ['remaining', completion.remaining],
            ['stored outcome', completion.stored ?? 'not recorded'],
            ['mismatch', completion.mismatch ? 'yes: the stored outcome disagrees with the derived state above' : 'no'],
          ]} />
          {facts.remainingWork.items.length ? (
            <div className="table-wrap">
              <table className="run-table facts-table">
                <caption className="finding-caption">Remaining work as the completion line counts it.</caption>
                <thead><tr><th scope="col">code</th><th scope="col" className="num">count</th><th scope="col">ids</th><th scope="col">message</th></tr></thead>
                <tbody>
                  {facts.remainingWork.items.map(item => (
                    <tr key={`${item.code}-${item.message}`}>
                      <td className="mono">{item.code}</td>
                      <td className="num">{item.count}</td>
                      <td className="mono wrap">{item.ids.join(', ') || 'none'}</td>
                      <td className="wrap">{item.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="facts-note">No item remains open in the completion line.</p>}
          {facts.remainingWork.settledBlocked.length ? (
            <div className="table-wrap">
              <table className="run-table facts-table">
                <caption className="finding-caption">Settled blocked work and the prerequisite each records.</caption>
                <thead><tr><th scope="col">task</th><th scope="col">blocked reason</th></tr></thead>
                <tbody>
                  {facts.remainingWork.settledBlocked.map(item => (
                    <tr key={item.id}><td className="mono">{item.id}</td><td className="wrap">{item.reason}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        <section id={sectionId('authority')} className="report-facts-section" aria-label="authority">
          <h2>Authority</h2>
          <FactsGrid rows={[
            ['planner / worker target ops', `${authority.plannerTargetOps} / ${authority.workerTargetOps}`],
            ['tasks created / dispatched', `${authority.tasksCreated} / ${authority.tasksDispatched}`],
            ['first dispatch', formatTime(authority.firstDispatchAt)],
            ['owner / worker claims', `${authority.ownerClaims} / ${authority.workerClaims}`],
            ['validation tasks', authority.validationTasks],
            ['stalled rounds', authority.stalledRounds],
            ['automatic wakes', authority.automaticWakes],
            ['campaign partial / resumes', `${authority.campaignPartial} / ${authority.campaignResumes}`],
            ['stall escalations', authority.stallEscalations],
            ['mode', authority.mode ? `${authority.mode.loopMode ?? 'loop not recorded'} · ${authority.mode.executorMode ?? 'executor not recorded'}` : 'not recorded'],
            ['role tool counts', `planner ${authority.roles.planner} · worker ${authority.roles.worker} · validation ${authority.roles.validation} · reporter ${authority.roles.reporter}`],
          ]} />
        </section>

        <section id={sectionId('summary')} className="report-facts-section" aria-label="summary">
          <h2>Summary</h2>
          <FactsGrid rows={[
            ['accepted-current findings', summary.acceptedCurrent],
            ['other cases', summary.otherCases],
            ['coverage cells', summary.coverageCells],
            ['non-clean cells', summary.notCleanCells],
            ['open gaps', summary.openGaps],
            ['worker claims', summary.workerClaims],
            ['worker handoffs', summary.workerHandoffs],
            ['awaiting review', summary.awaitingReview],
          ]} />
          <h3>tasks by status</h3>
          <Chips items={summary.tasksByStatus.map(item => ({ name: item.status, count: item.count }))} />
        </section>

        <section id={sectionId('findings')} className="report-facts-section" aria-label="findings">
          <h2>Findings</h2>
          {facts.findings.length ? (
            <div className="table-wrap">
              <table className="run-table facts-table">
                <caption className="finding-caption">Accepted-current shortlist; severity and score are the report&apos;s own, never re-rated here.</caption>
                <thead>
                  <tr>
                    <th scope="col">F</th><th scope="col">case</th><th scope="col">title</th><th scope="col">severity</th>
                    <th scope="col" className="num">cvss</th><th scope="col">cwe</th><th scope="col">wstg</th><th scope="col">independent validation</th>
                  </tr>
                </thead>
                <tbody>
                  {facts.findings.map(finding => (
                    <tr key={`${finding.caseId}-${finding.revision}`}>
                      <td className="num">F{finding.position}</td>
                      <td className="mono">{[finding.caseId, `r${finding.revision}`].filter(Boolean).join(' ')}</td>
                      <td className="wrap">{finding.title}</td>
                      <td>{severityLabel(finding.severity)}</td>
                      <td className="num">{finding.cvss ?? '-'}</td>
                      <td className="mono wrap">{finding.cwe.join(' ') || 'none'}</td>
                      <td className="mono wrap">{finding.wstg.join(' ') || 'none'}</td>
                      <td>{finding.independentValidationCurrent ? 'current' : 'not current'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="facts-note">No accepted-current finding in this reading.</p>}
          <OmittedNote count={facts.findingsOmitted} one="finding" />
        </section>

        <section id={sectionId('coverage')} className="report-facts-section" aria-label="coverage and gaps">
          <h2>Coverage &amp; gaps</h2>
          {facts.plans.length ? facts.plans.map(plan => (
            <div key={`${plan.id}-${plan.revision}`} className="fact-plan">
              <h3>{plan.title} <span className="dim mono">{plan.id} r{plan.revision}</span></h3>
              <FactsGrid rows={[
                ['status', plan.status],
                ['cells', `${plan.cells} cells · ${plan.reviewed} reviewed · ${plan.stale} stale`],
                ['execution', <Chips items={plan.execution} />],
                ['assessment', <Chips items={plan.assessment} />],
                ['excluded', plan.excluded.join('; ') || 'none recorded'],
                ['unknown scope', plan.unknownScope.join('; ') || 'none recorded'],
              ]} />
              {plan.notClean.length ? (
                <div className="table-wrap">
                  <table className="run-table facts-table">
                    <caption className="finding-caption">Non-clean cells: the same rows the coverage table prints.</caption>
                    <thead>
                      <tr>
                        <th scope="col">cell</th><th scope="col">asset</th><th scope="col">question</th><th scope="col">actor / method</th>
                        <th scope="col">execution</th><th scope="col">assessment</th><th scope="col">currentness</th><th scope="col">stale reasons</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.notClean.map(cell => (
                        <tr key={cell.cellId}>
                          <td className="mono">{cell.cellId}</td>
                          <td className="wrap">{cell.asset}</td>
                          <td className="mono wrap">{cell.questionKey}</td>
                          <td className="wrap">{cell.actorContext} / {cell.methodFamily}</td>
                          <td>{cell.execution}</td>
                          <td>{cell.assessment}</td>
                          <td>{cell.currentness}</td>
                          <td className="wrap">{cell.staleReasons.join('; ') || 'none'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="facts-note">No non-clean cell in this plan.</p>}
              <OmittedNote count={plan.notCleanOmitted} one="non-clean cell" />
            </div>
          )) : <p className="facts-note">No coverage plan in this reading.</p>}
          <OmittedNote count={facts.plansOmitted} one="coverage plan" />
        </section>

        <section id={sectionId('gaps')} className="report-facts-section" aria-label="open gaps">
          <h2>Open gaps</h2>
          {facts.openGaps.length ? (
            <div className="table-wrap">
              <table className="run-table facts-table">
                <caption className="finding-caption">Open entries the report lists; a missing row is not a clean result.</caption>
                <thead><tr><th scope="col">id</th><th scope="col">kind</th><th scope="col">by</th><th scope="col">gap</th></tr></thead>
                <tbody>
                  {facts.openGaps.map(gap => (
                    <tr key={gap.id}>
                      <td className="mono">{gap.id}</td>
                      <td>{gap.kind ?? 'not recorded'}</td>
                      <td>{gap.by ?? 'not recorded'}</td>
                      <td className="wrap">{gap.text ?? 'not recorded'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="facts-note">No open gap in this reading.</p>}
          <OmittedNote count={facts.openGapsOmitted} one="open gap" />
        </section>

        {facts.ladder ? (
          <section id={sectionId('ladder')} className="report-facts-section" aria-label="access ladder">
            <h2>Access ladder</h2>
            <FactsGrid rows={[
              ['mode', facts.ladder.mode],
              ['furthest', facts.ladder.furthest ?? 'not recorded'],
              ['severity / rated case', `${facts.ladder.severity ? severityLabel(facts.ladder.severity) : 'not rated'}${facts.ladder.ratedCase ? ` · ${facts.ladder.ratedCase}` : ''}`],
              ['claims', facts.ladder.claims],
            ]} />
            {facts.ladder.chain ? (
              <>
                <h3>
                  chain {facts.ladder.chain.caseId} r{facts.ladder.chain.revision} · {facts.ladder.chain.accepted ? 'accepted' : 'not accepted'} ·{' '}
                  demonstrated through {facts.ladder.chain.demonstratedThrough ?? 'not recorded'}
                </h3>
                <div className="table-wrap">
                  <table className="run-table facts-table">
                    <thead>
                      <tr>
                        <th scope="col" className="num">#</th><th scope="col">step</th><th scope="col">executed</th><th scope="col">rung</th>
                        <th scope="col">effect</th><th scope="col">capability</th><th scope="col">reach</th>
                      </tr>
                    </thead>
                    <tbody>
                      {facts.ladder.chain.steps.map(step => (
                        <tr key={`${step.order}-${step.step}`}>
                          <td className="num">{step.order}</td>
                          <td className="wrap">{step.step}</td>
                          <td>{step.executed ? (step.selfDeclared ? 'yes (self-declared)' : 'yes') : 'no'}</td>
                          <td>{step.rung ?? '-'}</td>
                          <td>{step.effect ?? '-'}</td>
                          <td className="wrap">{step.capability}</td>
                          <td className="wrap">{step.reach ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : <p className="facts-note">No demonstrated chain in this reading.</p>}
            <h3>walls</h3>
            {facts.ladder.walls.length ? (
              <ul className="notes">
                {facts.ladder.walls.map(wall => <li key={`${wall.rung}-${wall.wall}`}><span className="mono">{wall.rung}</span> {wall.wall}</li>)}
              </ul>
            ) : <p className="facts-note">No recorded wall.</p>}
            <h3>intended chains</h3>
            {facts.ladder.intended.length ? (
              <div className="table-wrap">
                <table className="run-table facts-table">
                  <thead><tr><th scope="col">case</th><th scope="col">objective</th><th scope="col" className="num">steps</th><th scope="col" className="num">demonstrated through</th></tr></thead>
                  <tbody>
                    {facts.ladder.intended.map(item => (
                      <tr key={`${item.caseId}-${item.revision}`}>
                        <td className="mono">{item.caseId} r{item.revision}</td>
                        <td className="wrap">{item.objective}</td>
                        <td className="num">{item.steps}</td>
                        <td className="num">{item.demonstratedThrough ?? '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="facts-note">No intended chain in this reading.</p>}
          </section>
        ) : null}

        <section id={sectionId('limits')} className="report-facts-section" aria-label="limits">
          <h2>Limits</h2>
          <FactsGrid rows={[
            ['row bound', facts.limits.rows],
            ['case-row bound', facts.limits.caseRows],
          ]} />
          <p className="facts-note">{facts.limits.note}</p>
        </section>
      </div>
    </div>
  );
}
